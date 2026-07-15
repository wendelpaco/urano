/**
 * Rate Limiter Middleware — Limite de requisições por API key.
 *
 * Usa Redis para sliding window de 1 minuto.
 * - Free tier: 200 req/min (padrão)
 * - Headers: X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset
 * - Excedido: 429 Too Many Requests com Retry-After
 *
 * Design: injetável — permite testar sem Redis.
 */

import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { redis } from '../../services/redis.ts';

// ─── Config ──────────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 200;   // req/min por key
const WINDOW_SECONDS = 60;

// ─── Interface ───────────────────────────────────────────────────────────────

export interface RateLimitStore {
  /** Incrementa o contador da key na janela. Retorna o total atual. */
  increment(key: string, windowSeconds: number): Promise<number>;
  /** Retorna o TTL restante da janela (segundos) */
  ttl(key: string): Promise<number>;
}

// ─── Implementação Redis ─────────────────────────────────────────────────────

class RedisRateLimitStore implements RateLimitStore {
  async increment(key: string, windowSeconds: number): Promise<number> {
    const redisKey = `ratelimit:${key}`;
    try {
      // Sliding window: incrementa + define TTL na primeira vez
      const count = await redis.incr(redisKey);
      if (count === 1) {
        await redis.expire(redisKey, windowSeconds);
      }
      return count;
    } catch {
      // Redis offline → permite passar (degradação)
      return 0;
    }
  }

  async ttl(key: string): Promise<number> {
    try {
      return await redis.ttl(`ratelimit:${key}`);
    } catch {
      return 60; // fallback
    }
  }
}

// ─── Implementação em memória (testes) ───────────────────────────────────────

export class MemoryRateLimitStore implements RateLimitStore {
  private store = new Map<string, { count: number; resetAt: number }>();

  async increment(key: string, windowSeconds: number): Promise<number> {
    const now = Date.now();
    const entry = this.store.get(key);

    if (!entry || now > entry.resetAt) {
      this.store.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
      return 1;
    }

    entry.count++;
    return entry.count;
  }

  async ttl(key: string): Promise<number> {
    const entry = this.store.get(key);
    if (!entry) return 60;
    return Math.max(0, Math.ceil((entry.resetAt - Date.now()) / 1000));
  }
}

// ─── Middleware Factory ──────────────────────────────────────────────────────

export interface RateLimitOptions {
  /** Limite de requisições por janela (default: 200) */
  limit?: number;
  /** Tamanho da janela em segundos (default: 60) */
  windowSeconds?: number;
  /** Rotas públicas (isenta de rate limit) */
  publicPaths?: Set<string>;
  /** Store customizado (Redis ou memória) */
  store?: RateLimitStore;
}

/**
 * Cria um hook onRequest que aplica rate limiting por API key.
 *
 * Headers enviados na resposta:
 *   X-RateLimit-Limit:       limite máximo
 *   X-RateLimit-Remaining:   restantes na janela atual
 *   X-RateLimit-Reset:       segundos até resetar
 *
 * Excedido → 429 com header Retry-After.
 */
export function buildRateLimiter(options: RateLimitOptions = {}) {
  const {
    limit = DEFAULT_LIMIT,
    windowSeconds = WINDOW_SECONDS,
    publicPaths = new Set(['/v1/healthcheck']),
    store = new RedisRateLimitStore(),
  } = options;

  return async function rateLimiterHook(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    // Rotas públicas isentas
    const path = request.url.split('?')[0] ?? request.url;
    if (publicPaths.has(path)) return;

    // Identificador: hash da key (nunca o secret em texto plano no Redis).
    const apiKey = (request.headers['x-api-key'] as string) || '';
    const rateLimitKey = apiKey
      ? createHash('sha256').update(apiKey).digest('hex')
      : 'anonymous';

    const current = await store.increment(rateLimitKey, windowSeconds);
    const remaining = Math.max(0, limit - current);
    const resetIn = await store.ttl(rateLimitKey);

    // Headers informativos
    reply.header('X-RateLimit-Limit', String(limit));
    reply.header('X-RateLimit-Remaining', String(remaining));
    reply.header('X-RateLimit-Reset', String(resetIn));

    if (current > limit) {
      reply.header('Retry-After', String(resetIn));
      reply.status(429).send({
        error: 'TooManyRequests',
        message: `Limite de ${limit} requisições por minuto excedido. Tente novamente em ${resetIn}s.`,
        limit,
        remaining: 0,
        resetInSeconds: resetIn,
      });
    }
  };
}

// ─── Middleware padrão (Redis) ───────────────────────────────────────────────

/** Rate limiter pronto para uso em produção (com Redis) */
export const rateLimiter = buildRateLimiter();
