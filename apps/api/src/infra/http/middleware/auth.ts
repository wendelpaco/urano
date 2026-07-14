/**
 * Auth Middleware — Validação de API key via header x-api-key.
 *
 * Onda 3a: todas as rotas exceto /v1/healthcheck exigem api-key ativa.
 * Cache Redis de keys válidas (TTL 60s) para não bater no banco por request.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db } from '../../database/connection.ts';
import { apiKeys } from '../../database/schema.ts';
import { redis } from '../../services/redis.ts';

// Rotas públicas: healthcheck + criação de key (para bootstrap)
const PUBLIC_ROUTES = new Set(['/v1/healthcheck', '/v1/keys']);

function isPublicRoute(url: string): boolean {
  // /v1/keys só é público para POST (criação); GET e DELETE exigem auth
  if (url === '/v1/keys') return true;
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

  // Cache Redis: verifica se key é válida
  try {
    const valid = await redis.get(`apikey:valid:${key}`);
    if (valid === 'true') {
      // Atualiza last_used_at em background (fire-and-forget)
      updateLastUsed(key).catch(() => {});
      return;
    }
    if (valid === 'false') {
      reply.status(401).send({
        error: 'Unauthorized',
        message: 'API key inválida ou inativa.',
      });
      return;
    }
  } catch {
    // Redis offline → fallback para banco
  }

  // Consulta o banco
  let row: { key: string; active: boolean } | undefined;
  try {
    const result = await db
      .select({ key: apiKeys.key, active: apiKeys.active })
      .from(apiKeys)
      .where(and(eq(apiKeys.key, key), eq(apiKeys.active, true)));
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
      await redis.setex(`apikey:valid:${key}`, 60, 'false');
    } catch { /* ok */ }

    reply.status(401).send({
      error: 'Unauthorized',
      message: 'API key inválida ou inativa.',
    });
    return;
  }

  // Cache positivo (60s)
  try {
    await redis.setex(`apikey:valid:${key}`, 60, 'true');
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
    await db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.key, key));
  } catch {
    // Silencioso — last_used_at é métrica secundária
  }
}
