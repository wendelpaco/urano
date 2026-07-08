import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import { eq, desc } from 'drizzle-orm';
import { db } from '../../database/connection.ts';
import { apiKeys, users } from '../../database/schema.ts';

function sendZodError(reply: FastifyReply, error: z.ZodError, message: string): void {
  reply.status(400).send({
    error: 'ValidationError',
    message,
    details: error.issues.map(({ path, message: m }) => ({ path: path.join('.'), message: m })),
  });
}

const createKeySchema = z.object({
  name: z.string().min(1).max(100),
});

const deleteParamsSchema = z.object({ id: z.string().uuid() });

function generateApiKey(): string {
  const segments = Array.from({ length: 4 }, () =>
    crypto.randomBytes(6).toString('hex'),
  );
  return `ur_${segments.join('_')}`;
}

/** POST /v1/keys */
export async function createApiKeyController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = createKeySchema.safeParse(request.body);
  if (!parsed.success) return sendZodError(reply, parsed.error, 'Payload inválido.');

  const { name } = parsed.data;
  const key = generateApiKey();

  // Shim temporário (Task 2): sem fluxo de conta ainda, toda key criada por
  // este endpoint legado é atribuída ao usuário admin da migração de backfill.
  // keyHash aqui é a própria key em texto plano — corrigido na Task 4 (hash
  // sha-256) e este endpoint é substituído/removido na Task 11.
  const [admin] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, 'admin@urano.local'));

  const [row] = await db
    .insert(apiKeys)
    .values({
      userId: admin!.id,
      name,
      keyHash: key,
      keyPrefix: key.slice(0, 12),
    })
    .returning();

  reply.status(201).send({
    id: row!.id,
    name: row!.name,
    key,
    active: row!.active,
    createdAt: row!.createdAt?.toISOString(),
    message: 'Guarde esta chave. Por segurança, ela não será exibida novamente.',
  });
}

/** GET /v1/keys */
export async function listApiKeysController(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const rows = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      active: apiKeys.active,
      lastUsedAt: apiKeys.lastUsedAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .orderBy(desc(apiKeys.createdAt));

  reply.send({ total: rows.length, data: rows });
}

/** DELETE /v1/keys/:id */
export async function deleteApiKeyController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = deleteParamsSchema.safeParse(request.params);
  if (!parsed.success) return sendZodError(reply, parsed.error, 'ID inválido.');

  const { id } = parsed.data;

  const [updated] = await db
    .update(apiKeys)
    .set({ active: false })
    .where(eq(apiKeys.id, id))
    .returning({ id: apiKeys.id });

  if (!updated) {
    reply.status(404).send({ error: 'NotFound', message: 'API Key não encontrada.' });
    return;
  }

  reply.send({ message: 'API Key desativada.', id: updated.id });
}
