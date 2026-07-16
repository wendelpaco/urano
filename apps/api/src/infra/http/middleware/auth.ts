/**
 * Auth Middleware — Validação de API key via header x-api-key.
 *
 * Todas as rotas exceto /v1/healthcheck exigem api-key ativa.
 * Cache Redis de keys válidas (TTL 60s) — valor: JSON { id, scopes }.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { db } from '../../database/connection.ts';
import { apiKeys } from '../../database/schema.ts';
import { redis } from '../../services/redis.ts';
import { normalizeScopes } from '../scopes.ts';

declare module 'fastify' {
  interface FastifyRequest {
    apiKeyId?: string;
    /** Normalized scopes for this key (from DB / cache). */
    scopes?: string[];
  }
}

const PUBLIC_PATHS = new Set(['/v1/healthcheck']);

/** Path without query string — prevents probe mismatch and accidental auth skips. */
export function pathOnly(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

function isPublicPath(url: string): boolean {
  return PUBLIC_PATHS.has(pathOnly(url));
}

interface CachedAuth {
  id: string;
  scopes: string[];
}

export const AUTH_CACHE_TTL_SECONDS = 60;

/** Hashes revogados localmente protegem este processo mesmo se Redis cair. */
const locallyInvalidatedUntil = new Map<string, number>();

export function authCacheKey(keyHash: string): string {
  return `apikey:valid:${keyHash}`;
}

function isLocallyInvalidated(keyHash: string): boolean {
  const until = locallyInvalidatedUntil.get(keyHash);
  if (until === undefined) return false;
  if (until <= Date.now()) {
    locallyInvalidatedUntil.delete(keyHash);
    return false;
  }
  return true;
}

/**
 * Invalida imediatamente uma credencial rotacionada/desativada.
 *
 * O marcador negativo substitui um eventual cache positivo no Redis
 * compartilhado. O fallback local cobre a instância que processou a operação
 * caso Redis esteja indisponível naquele instante.
 */
export async function invalidateCachedAuth(keyHash: string): Promise<boolean> {
  const now = Date.now();
  // A lista só precisa sobreviver ao TTL do cache positivo. A limpeza durante
  // mutações evita crescimento permanente sem criar um timer por chave.
  for (const [hash, until] of locallyInvalidatedUntil) {
    if (until <= now) locallyInvalidatedUntil.delete(hash);
  }
  locallyInvalidatedUntil.set(
    keyHash,
    now + AUTH_CACHE_TTL_SECONDS * 1000,
  );
  try {
    await redis.setex(authCacheKey(keyHash), AUTH_CACHE_TTL_SECONDS, 'false');
    return true;
  } catch {
    console.warn('[auth] Redis indisponível ao invalidar cache; bloqueio local aplicado');
    return false;
  }
}

export function parseCachedAuth(raw: string): CachedAuth | null {
  if (raw === 'false') return null;
  // Cache legado sem scopes deve virar cache miss e consultar o banco. Conceder
  // scopes bootstrap durante o TTL escalaria privilégios de chaves filhas.
  if (/^[0-9a-f-]{36}$/i.test(raw)) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { id?: string; scopes?: unknown };
    if (
      typeof parsed.id === 'string'
      && Array.isArray(parsed.scopes)
      && parsed.scopes.length > 0
    ) {
      return { id: parsed.id, scopes: normalizeScopes(parsed.scopes) };
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Hook onRequest: valida x-api-key em toda rota não-pública.
 * Atualiza last_used_at no banco a cada request autenticado.
 */
export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (isPublicPath(request.url)) return;

  const key = request.headers['x-api-key'] as string | undefined;
  if (!key) {
    reply.status(401).send({
      error: 'Unauthorized',
      message: 'Header x-api-key é obrigatório.',
    });
    return;
  }

  const keyHash = createHash('sha256').update(key).digest('hex');

  if (isLocallyInvalidated(keyHash)) {
    reply.status(401).send({
      error: 'Unauthorized',
      message: 'API key inválida ou inativa.',
    });
    return;
  }

  try {
    const cached = await redis.get(authCacheKey(keyHash));
    if (cached === 'false') {
      reply.status(401).send({
        error: 'Unauthorized',
        message: 'API key inválida ou inativa.',
      });
      return;
    }
    if (cached) {
      const auth = parseCachedAuth(cached);
      if (auth) {
        request.apiKeyId = auth.id;
        request.scopes = auth.scopes;
        updateLastUsed(keyHash).catch(() => {});
        return;
      }
    }
  } catch {
    // Redis offline → fallback para banco
  }

  let row: { id: string; scopes: string[] | null } | undefined;
  try {
    const result = await db
      .select({
        id: apiKeys.id,
        scopes: apiKeys.scopes,
      })
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.active, true)));
    row = result[0];
  } catch {
    console.error('[auth] Banco indisponível — negando acesso (fail-closed)');
    reply.status(503).send({
      error: 'ServiceUnavailable',
      message: 'Serviço de autenticação indisponível. Tente novamente em instantes.',
    });
    return;
  }

  if (!row) {
    try {
      await redis.setex(authCacheKey(keyHash), AUTH_CACHE_TTL_SECONDS, 'false');
    } catch { /* ok */ }

    reply.status(401).send({
      error: 'Unauthorized',
      message: 'API key inválida ou inativa.',
    });
    return;
  }

  const scopes = normalizeScopes(row.scopes);
  request.apiKeyId = row.id;
  request.scopes = scopes;

  try {
    // NX impede uma autenticação que começou antes de rotate/delete de
    // sobrescrever o marcador negativo publicado pela revogação.
    await redis.set(
      authCacheKey(keyHash),
      JSON.stringify({ id: row.id, scopes }),
      'EX',
      AUTH_CACHE_TTL_SECONDS,
      'NX',
    );
  } catch { /* ok */ }

  updateLastUsed(keyHash).catch(() => {});
}

async function updateLastUsed(keyHash: string): Promise<void> {
  try {
    await db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.keyHash, keyHash));
  } catch {
    // Silencioso
  }
}
