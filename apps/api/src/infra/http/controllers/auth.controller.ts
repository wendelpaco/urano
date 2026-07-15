import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import { eq, or, desc } from 'drizzle-orm';
import { db } from '../../database/connection.ts';
import { apiKeys } from '../../database/schema.ts';
import { logSecurityEvent } from '../audit-log.ts';
import {
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
  /** Optional subset; admin scopes stripped unless caller has admin:keys (and still only if requested). */
  scopes: z.array(z.string().min(1).max(32)).max(10).optional(),
});

const deleteParamsSchema = z.object({ id: z.string().uuid() });
const rotateParamsSchema = z.object({ id: z.string().uuid() });

function generateApiKey(): string {
  const segments = Array.from({ length: 4 }, () =>
    crypto.randomBytes(6).toString('hex'),
  );
  return `ur_${segments.join('_')}`;
}

function keyStoredFromHash(keyHash: string): string {
  return `ur_hashonly_${keyHash.slice(0, 24)}`;
}

/** Child keys never inherit admin:* unless caller explicitly passes and has admin:keys. */
function resolveChildScopes(
  requested: string[] | undefined,
  callerScopes: string[] | undefined,
): string[] {
  const base = requested?.length ? requested : DEFAULT_CHILD_SCOPES;
  const allowed = base.filter((s) => {
    if (s === '*' || s.startsWith('admin:')) {
      return hasScope(callerScopes, 'admin:keys') && (s === 'admin:keys' || s === 'admin:ops' || s === '*');
    }
    return ['read:market', 'write:wallet', 'admin:keys', 'admin:ops'].includes(s);
  });
  // Never grant * via HTTP create
  const cleaned = allowed.filter((s) => s !== '*');
  return cleaned.length > 0 ? cleaned : [...DEFAULT_CHILD_SCOPES];
}

/** Can manage target key: self, or child owned by caller with admin:keys. */
async function canManageKey(
  callerId: string,
  targetId: string,
  callerScopes: string[] | undefined,
): Promise<boolean> {
  if (callerId === targetId) return true;
  if (!hasScope(callerScopes, 'admin:keys')) return false;
  const [row] = await db
    .select({ ownerId: apiKeys.ownerId })
    .from(apiKeys)
    .where(eq(apiKeys.id, targetId));
  return row?.ownerId === callerId;
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
  const keyStored = keyStoredFromHash(keyHash);
  const scopes = resolveChildScopes(requestedScopes, request.scopes);
  const ownerId = request.apiKeyId!;

  const [row] = await db
    .insert(apiKeys)
    .values({
      name,
      key: keyStored,
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
  const allowed = await canManageKey(request.apiKeyId!, id, request.scopes);
  if (!allowed) {
    // 404 — same shape as missing (don't confirm foreign key existence)
    reply.status(404).send({ error: 'NotFound', message: 'API Key não encontrada.' });
    return;
  }

  const newKey = generateApiKey();
  const newKeyHash = crypto.createHash('sha256').update(newKey).digest('hex');
  const keyStored = keyStoredFromHash(newKeyHash);

  const [updated] = await db
    .update(apiKeys)
    .set({ key: keyStored, keyHash: newKeyHash })
    .where(eq(apiKeys.id, id))
    .returning();

  if (!updated) {
    reply.status(404).send({ error: 'NotFound', message: 'API Key não encontrada.' });
    return;
  }

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
  const allowed = await canManageKey(request.apiKeyId!, id, request.scopes);
  if (!allowed) {
    reply.status(404).send({ error: 'NotFound', message: 'API Key não encontrada.' });
    return;
  }

  const [updated] = await db
    .update(apiKeys)
    .set({ active: false })
    .where(eq(apiKeys.id, id))
    .returning({ id: apiKeys.id });

  if (!updated) {
    reply.status(404).send({ error: 'NotFound', message: 'API Key não encontrada.' });
    return;
  }

  logSecurityEvent('api_key.delete', {
    apiKeyId: updated.id,
    requestedBy: request.apiKeyId,
  });

  reply.send({ message: 'API Key desativada.', id: updated.id });
}

// re-export for CLI typing convenience
export { BOOTSTRAP_SCOPES };
