import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq, desc, isNull } from 'drizzle-orm';
import { db } from '../../database/connection.ts';
import { apiKeys } from '../../database/schema.ts';

const createKeySchema = z.object({
  name: z.string().min(1).max(100),
});

function generateApiKey(): string {
  const chars = 'abcdef0123456789';
  const segments = Array.from({ length: 4 }, () =>
    Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''),
  );
  return `ur_${segments.join('_')}`;
}

/**
 * POST /v1/keys
 * Cria uma nova API Key.
 */
export async function createApiKeyController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { name } = createKeySchema.parse(request.body);

  const key = generateApiKey();

  const [row] = await db
    .insert(apiKeys)
    .values({ name, key })
    .returning();

  reply.status(201).send({
    id: row!.id,
    name: row!.name,
    key: row!.key,
    active: row!.active,
    createdAt: row!.createdAt?.toISOString(),
    message: 'Guarde esta chave. Por segurança, ela não será exibida novamente.',
  });
}

/**
 * GET /v1/keys
 * Lista todas as API Keys (sem exibir o segredo).
 */
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

/**
 * DELETE /v1/keys/:id
 * Desativa uma API Key (soft-delete: apenas marca como inativa).
 */
export async function deleteApiKeyController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

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
