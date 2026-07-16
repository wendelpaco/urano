/**
 * Rate Limiter Middleware — duas camadas independentes:
 *
 * 1. IP, antes da autenticação: impede que um atacante crie um bucket novo a
 *    cada valor aleatório enviado em x-api-key.
 * 2. ID da API key, depois da autenticação: limita uma credencial válida mesmo
 *    quando ela é usada a partir de vários IPs.
 *
 * A chave em texto puro nunca é usada como identidade nem armazenada no Redis.
 * Design injetável para permitir testes sem Redis.
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

export interface RedisRateLimitClient {
  eval(
    script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
  ttl(key: string): Promise<number>;
}

const INCREMENT_WITH_EXPIRY_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])

-- TTL -1 means a counter exists without expiration (for example, one left by
-- the former two-command implementation after a connection failure). Repair
-- it in the same atomic script that increments the counter. TTL -2 is also
-- covered defensively, although INCR normally creates the key first.
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
end

return count
`;

export class RedisRateLimitStore implements RateLimitStore {
  constructor(
    private readonly failClosed = false,
    private readonly client: RedisRateLimitClient = redis,
  ) {}

  async increment(key: string, windowSeconds: number): Promise<number> {
    const redisKey = `ratelimit:${key}`;
    try {
      // One server-side operation: a lost connection can make the result
      // ambiguous, but can no longer persist INCR without its expiration.
      const rawCount = await this.client.eval(
        INCREMENT_WITH_EXPIRY_SCRIPT,
        1,
        redisKey,
        windowSeconds,
      );
      const count = Number(rawCount);
      if (!Number.isSafeInteger(count) || count < 1) {
        throw new Error('Resposta inválida do Redis ao incrementar rate limit.');
      }
      return count;
    } catch (err) {
      if (this.failClosed) {
        // Fail-closed: surface the error so the middleware can deny the request.
        throw err;
      }
      // Fail-open (default): Redis offline → allow traffic (degraded).
      return 0;
    }
  }

  async ttl(key: string): Promise<number> {
    try {
      return await this.client.ttl(`ratelimit:${key}`);
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
  /** Rotas explicitamente isentas. Por padrão nenhuma rota é isenta. */
  publicPaths?: Set<string>;
  /** Limites menores para rotas específicas, em uma janela/bucket separado. */
  pathLimits?: Readonly<Record<string, number>>;
  /** Identidade segura usada pelo bucket. Default: IP observado pelo Fastify. */
  identity?: 'ip' | 'authenticatedKey';
  /** Store customizado (Redis ou memória) */
  store?: RateLimitStore;
  /**
   * When the store throws (e.g. Redis down): deny with 503 instead of allowing traffic.
   * Default false = fail-open (backward compatible). Wire from env.RATE_LIMIT_FAIL_CLOSED in server.
   */
  failClosed?: boolean;
}

/**
 * Cria um hook que aplica rate limiting pela identidade configurada.
 *
 * Headers enviados na resposta:
 *   X-RateLimit-Limit:       limite máximo
 *   X-RateLimit-Remaining:   restantes na janela atual
 *   X-RateLimit-Reset:       segundos até resetar
 *
 * Excedido → 429 com header Retry-After.
 * Store failure + failClosed → 503 Service Unavailable.
 */
export function buildRateLimiter(options: RateLimitOptions = {}) {
  const {
    limit = DEFAULT_LIMIT,
    windowSeconds = WINDOW_SECONDS,
    publicPaths = new Set<string>(),
    pathLimits = {},
    identity = 'ip',
    failClosed = false,
    store = new RedisRateLimitStore(failClosed),
  } = options;

  return async function rateLimiterHook(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    // Apenas rotas explicitamente configuradas ficam isentas. O healthcheck é
    // público, mas deliberadamente continua limitado para não virar um probe
    // gratuito contra Postgres/Redis.
    const path = request.url.split('?')[0] ?? request.url;
    if (publicPaths.has(path)) return;

    let baseKey: string | null;
    if (identity === 'authenticatedKey') {
      // apiKeyId só é anexado pelo authMiddleware após DB/cache validar a key.
      // Em healthcheck (público) ele não existe e esta segunda camada é pulada.
      baseKey = request.apiKeyId ? `apikey:${request.apiKeyId}` : null;
    } else {
      // Hash evita persistir endereço IP em texto puro no Redis.
      const ip = request.ip || 'unknown';
      const ipHash = createHash('sha256').update(ip).digest('hex');
      baseKey = `ip:${ipHash}`;
    }
    if (!baseKey) return;

    const pathLimit = pathLimits[path];
    const effectiveLimit = pathLimit ?? limit;
    if (!Number.isInteger(effectiveLimit) || effectiveLimit <= 0) {
      throw new Error(`Rate limit inválido para ${path}: ${effectiveLimit}`);
    }
    // Overrides usam bucket próprio: probes de health não consomem a cota das
    // rotas de produto e vice-versa.
    const rateLimitKey = pathLimit === undefined
      ? baseKey
      : `${baseKey}:path:${createHash('sha256').update(path).digest('hex')}`;

    let current: number;
    try {
      current = await store.increment(rateLimitKey, windowSeconds);
    } catch {
      if (failClosed) {
        reply.status(503).send({
          error: 'ServiceUnavailable',
          message: 'Serviço de rate limit indisponível. Tente novamente em instantes.',
        });
        return;
      }
      // Fail-open: allow traffic when store is down.
      return;
    }

    const remaining = Math.max(0, effectiveLimit - current);
    const resetIn = await store.ttl(rateLimitKey);

    // Headers informativos
    reply.header('X-RateLimit-Limit', String(effectiveLimit));
    reply.header('X-RateLimit-Remaining', String(remaining));
    reply.header('X-RateLimit-Reset', String(resetIn));

    if (current > effectiveLimit) {
      reply.header('Retry-After', String(resetIn));
      reply.status(429).send({
        error: 'TooManyRequests',
        message: `Limite de ${effectiveLimit} requisições por minuto excedido. Tente novamente em ${resetIn}s.`,
        limit: effectiveLimit,
        remaining: 0,
        resetInSeconds: resetIn,
      });
    }
  };
}
