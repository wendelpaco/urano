import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import { and, eq, or, desc } from 'drizzle-orm';
import { db } from '../../database/connection.ts';
import { apiKeys } from '../../database/schema.ts';
import { invalidateCachedAuth } from '../middleware/auth.ts';
import { logSecurityEvent } from '../audit-log.ts';
import {
  ALL_SCOPES,
  DEFAULT_CHILD_SCOPES,
  BOOTSTRAP_SCOPES,
  requireScope,
  hasScope,
  normalizeScopes,
} from '../scopes.ts';

function sendZodError(reply: FastifyReply, error: z.ZodError, message: string): void {
  reply.status(400).send({
    error: 'ValidationError',
    message,
    details: error.issues.map(({ path, message: m }) => ({ path: path.join('.'), message: m })),
  });
}

const createKeySchema = z.object({
  name: z.string().min(1).max(100),
  /** Optional non-admin subset of the caller's own effective scopes. */
  scopes: z
    .array(z.enum(ALL_SCOPES))
    .min(1)
    .max(ALL_SCOPES.length)
    .refine(
      (items) => new Set(items).size === items.length,
      'Escopos duplicados não são permitidos',
    )
    .optional(),
});

const deleteParamsSchema = z.object({ id: z.string().uuid() });
const rotateParamsSchema = z.object({ id: z.string().uuid() });

function generateApiKey(): string {
  const segments = Array.from({ length: 4 }, () =>
    crypto.randomBytes(6).toString('hex'),
  );
  return `ur_${segments.join('_')}`;
}

export interface ChildScopeResolution {
  scopes: string[];
  denied: string[];
}

function isAdministrativeScope(scope: string): boolean {
  return scope === '*' || scope.startsWith('admin:');
}

/**
 * HTTP-created child keys are limited to a non-administrative subset of the
 * caller's effective scopes. Administrative keys are bootstrap/CLI-only so a
 * leaked child credential cannot create another privileged generation.
 */
export function resolveChildScopes(
  requested: string[] | undefined,
  callerScopes: string[] | undefined,
): ChildScopeResolution {
  // Defaults are an intersection (not an inheritance): a key with only
  // admin:keys must never implicitly grant read:market/write:wallet.
  const candidates = requested?.length
    ? requested
    : DEFAULT_CHILD_SCOPES.filter((scope) => hasScope(callerScopes, scope));
  const denied = candidates.filter(
    (scope) => isAdministrativeScope(scope)
      || !ALL_SCOPES.includes(scope as (typeof ALL_SCOPES)[number])
      || !hasScope(callerScopes, scope),
  );
  const scopes = candidates.filter(
    (scope) => !isAdministrativeScope(scope)
      && ALL_SCOPES.includes(scope as (typeof ALL_SCOPES)[number])
      && hasScope(callerScopes, scope),
  );
  return { scopes: [...new Set(scopes)], denied: [...new Set(denied)] };
}

interface ManageableKey {
  id: string;
  ownerId: string | null;
  keyHash: string;
}

/** Returns target metadata only for self or a directly owned child. */
async function getManageableKey(
  callerId: string,
  targetId: string,
  callerScopes: string[] | undefined,
): Promise<ManageableKey | null> {
  // Avoid a DB lookup and do not reveal whether a foreign key exists.
  if (callerId !== targetId && !hasScope(callerScopes, 'admin:keys')) return null;
  const [row] = await db
    .select({ id: apiKeys.id, ownerId: apiKeys.ownerId, keyHash: apiKeys.keyHash })
    .from(apiKeys)
    .where(and(eq(apiKeys.id, targetId), eq(apiKeys.active, true)));
  if (!row) return null;
  if (callerId === targetId || row.ownerId === callerId) return row;
  return null;
}

/** POST /v1/keys — requires admin:keys; creates a child key owned by caller */
export async function createApiKeyController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!requireScope(request, reply, 'admin:keys')) return;

  const parsed = createKeySchema.safeParse(request.body);
  if (!parsed.success) return sendZodError(reply, parsed.error, 'Payload inválido.');

  const { name, scopes: requestedScopes } = parsed.data;
  const key = generateApiKey();
  const keyHash = crypto.createHash('sha256').update(key).digest('hex');
  const resolution = resolveChildScopes(requestedScopes, request.scopes);
  if (resolution.denied.length > 0) {
    reply.status(403).send({
      error: 'Forbidden',
      message: 'Uma chave filha HTTP só pode receber escopos não administrativos que o criador possui.',
      deniedScopes: resolution.denied,
    });
    return;
  }
  if (resolution.scopes.length === 0) {
    reply.status(400).send({
      error: 'ValidationError',
      message: 'Nenhum escopo delegável foi informado. Solicite um subconjunto dos escopos da chave atual.',
    });
    return;
  }
  const scopes = resolution.scopes;
  const ownerId = request.apiKeyId!;

  const [row] = await db
    .insert(apiKeys)
    .values({
      name,
      // keyStored removido (SEC-1r) — coluna 'key' foi dropada na migration 0019
      keyHash,
      ownerId,
      scopes,
    })
    .returning();

  logSecurityEvent('api_key.create', {
    apiKeyId: row!.id,
    name: row!.name,
    ownerId,
    scopes,
  });

  reply.status(201).send({
    id: row!.id,
    name: row!.name,
    key, // plaintext ONCE
    scopes: row!.scopes,
    ownerId: row!.ownerId,
    active: row!.active,
    createdAt: row!.createdAt?.toISOString(),
    message: 'Guarde esta chave. Por segurança, ela não será exibida novamente.',
  });
}

/**
 * GET /v1/keys — only self + children owned by caller (never global dump).
 * Requires admin:keys to list children; without it, returns only the caller's own key metadata.
 */
export async function listApiKeysController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const callerId = request.apiKeyId!;
  const canListChildren = hasScope(request.scopes, 'admin:keys');

  const rows = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      active: apiKeys.active,
      ownerId: apiKeys.ownerId,
      scopes: apiKeys.scopes,
      lastUsedAt: apiKeys.lastUsedAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(
      canListChildren
        ? or(eq(apiKeys.id, callerId), eq(apiKeys.ownerId, callerId))
        : eq(apiKeys.id, callerId),
    )
    .orderBy(desc(apiKeys.createdAt));

  reply.send({ total: rows.length, data: rows });
}

/** POST /v1/keys/:id/rotate */
export async function rotateApiKeyController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = rotateParamsSchema.safeParse(request.params);
  if (!parsed.success) return sendZodError(reply, parsed.error, 'ID inválido.');

  const { id } = parsed.data;
  const target = await getManageableKey(request.apiKeyId!, id, request.scopes);
  if (!target) {
    // 404 — same shape as missing (don't confirm foreign key existence)
    reply.status(404).send({ error: 'NotFound', message: 'API Key não encontrada.' });
    return;
  }

  const newKey = generateApiKey();
  const newKeyHash = crypto.createHash('sha256').update(newKey).digest('hex');

  const [updated] = await db
    .update(apiKeys)
    .set({ keyHash: newKeyHash })
    .where(and(
      eq(apiKeys.id, id),
      eq(apiKeys.keyHash, target.keyHash),
      eq(apiKeys.active, true),
    ))
    .returning();

  if (!updated) {
    await invalidateCachedAuth(target.keyHash);
    reply.status(409).send({
      error: 'Conflict',
      message: 'A API Key foi alterada por outra operação. Recarregue o estado antes de tentar novamente.',
    });
    return;
  }

  await invalidateCachedAuth(target.keyHash);

  logSecurityEvent('api_key.rotate', {
    apiKeyId: updated.id,
    requestedBy: request.apiKeyId,
  });

  reply.send({
    id: updated.id,
    name: updated.name,
    key: newKey,
    scopes: normalizeScopes(updated.scopes),
    active: updated.active,
    message: 'Chave rotacionada. A chave anterior deixou de funcionar. Guarde a nova.',
  });
}

/** DELETE /v1/keys/:id — soft-deactivate */
export async function deleteApiKeyController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = deleteParamsSchema.safeParse(request.params);
  if (!parsed.success) return sendZodError(reply, parsed.error, 'ID inválido.');

  const { id } = parsed.data;
  const target = await getManageableKey(request.apiKeyId!, id, request.scopes);
  if (!target) {
    reply.status(404).send({ error: 'NotFound', message: 'API Key não encontrada.' });
    return;
  }

  const [updated] = await db
    .update(apiKeys)
    .set({ active: false })
    .where(and(
      eq(apiKeys.id, id),
      eq(apiKeys.keyHash, target.keyHash),
      eq(apiKeys.active, true),
    ))
    .returning({ id: apiKeys.id });

  if (!updated) {
    await invalidateCachedAuth(target.keyHash);
    reply.status(409).send({
      error: 'Conflict',
      message: 'A API Key foi alterada por outra operação. Recarregue o estado antes de tentar novamente.',
    });
    return;
  }

  await invalidateCachedAuth(target.keyHash);

  logSecurityEvent('api_key.delete', {
    apiKeyId: updated.id,
    requestedBy: request.apiKeyId,
  });

  reply.send({ message: 'API Key desativada.', id: updated.id });
}

// re-export for CLI typing convenience
export { BOOTSTRAP_SCOPES };
