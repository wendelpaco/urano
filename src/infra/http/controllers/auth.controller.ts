import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import { eq, desc } from 'drizzle-orm';
import { db } from '../../database/connection.ts';
import { apiKeys } from '../../database/schema.ts';

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
