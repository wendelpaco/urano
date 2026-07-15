/**
 * Auth Middleware — Validação de API key via header x-api-key.
 *
 * Onda 3a: todas as rotas exceto /v1/healthcheck exigem api-key ativa.
 * Cache Redis de keys válidas (TTL 60s) para não bater no banco por request.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { db } from '../../database/connection.ts';
import { apiKeys } from '../../database/schema.ts';
import { redis } from '../../services/redis.ts';

declare module 'fastify' {
  interface FastifyRequest {
    apiKeyId?: string;
  }
}

// Rotas públicas: só healthcheck. Bootstrap de key é feito via `bun run key:create`
// (script CLI, acesso direto ao banco) — a rota HTTP de criação agora exige auth
// como qualquer outra, então só quem já tem uma key pode provisionar mais.
const PUBLIC_ROUTES = new Set(['/v1/healthcheck']);

function isPublicRoute(url: string): boolean {
  return PUBLIC_ROUTES.has(url);
}

/**
 * Hook onRequest: valida x-api-key em toda rota não-pública.
 * Atualiza last_used_at no banco a cada request autenticado.
 */
export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Rotas públicas
  if (isPublicRoute(request.url) && request.method === 'POST') return;
  if (PUBLIC_ROUTES.has(request.url)) return;

  const key = request.headers['x-api-key'] as string | undefined;
  if (!key) {
    reply.status(401).send({
      error: 'Unauthorized',
      message: 'Header x-api-key é obrigatório.',
    });
    return;
  }

  // Hash da key: usado tanto para lookup no banco quanto como chave de cache
  // no Redis — nunca guardamos a key em texto plano em nenhum dos dois (V-06).
  const keyHash = createHash('sha256').update(key).digest('hex');

  try {
    const cached = await redis.get(`apikey:valid:${keyHash}`);
    if (cached === 'false') {
      reply.status(401).send({
        error: 'Unauthorized',
        message: 'API key inválida ou inativa.',
      });
      return;
    }
    if (cached) {
      // Valid key: cached value is the apiKeyId (uuid), not a boolean.
      request.apiKeyId = cached;
      updateLastUsed(key).catch(() => {});
      return;
    }
  } catch {
    // Redis offline → fallback para banco
  }

  // Consulta o banco
  let row: { key: string; active: boolean; id: string } | undefined;
  try {
    const result = await db
      .select({ key: apiKeys.key, active: apiKeys.active, id: apiKeys.id })
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.active, true)));
    row = result[0];
  } catch {
    // DB indisponível → nega a request (fail-closed). Uma vez que a API é
    // chamada direto do browser (sem proxy), deixar passar sem validar a
    // key equivale a desligar a autenticação inteira durante a indisponibilidade.
    console.error('[auth] Banco indisponível — negando acesso (fail-closed)');
    reply.status(503).send({
      error: 'ServiceUnavailable',
      message: 'Serviço de autenticação indisponível. Tente novamente em instantes.',
    });
    return;
  }

  if (!row) {
    // Cache negativo (60s) para evitar repeated DB hits com key inválida
    try {
      await redis.setex(`apikey:valid:${keyHash}`, 60, 'false');
    } catch { /* ok */ }

    reply.status(401).send({
      error: 'Unauthorized',
      message: 'API key inválida ou inativa.',
    });
    return;
  }

  request.apiKeyId = row.id;

  // Cache positivo (60s) — guarda o id, não um booleano
  try {
    await redis.setex(`apikey:valid:${keyHash}`, 60, row.id);
  } catch { /* ok */ }

  // Atualiza last_used_at em background
  updateLastUsed(key).catch(() => {});
}

/**
 * Atualiza last_used_at da key no banco.
 * Executado em background — falha não bloqueia o request.
 */
async function updateLastUsed(key: string): Promise<void> {
  try {
    const keyHash = createHash('sha256').update(key).digest('hex');
    await db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.keyHash, keyHash));
  } catch {
    // Silencioso — last_used_at é métrica secundária
  }
}
