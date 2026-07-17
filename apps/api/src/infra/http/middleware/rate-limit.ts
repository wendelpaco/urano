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

export interface RateLimitResult {
  /** Total de requisições na janela atual. */
  count: number;
  /** TTL restante da janela (segundos). */
  ttl: number;
}

export interface RateLimitStore {
  /** Incrementa o contador da key na janela. Retorna count + ttl. */
  increment(key: string, windowSeconds: number): Promise<RateLimitResult>;
}

// ─── Implementação Redis ─────────────────────────────────────────────────────

export interface RedisRateLimitClient {
  eval(
    script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
}

// N-5: script Lua retorna {count, ttl} em um único round-trip Redis.
// Antes: INCR+TTL (atômico) + comando TTL separado = 2 round-trips.
const INCREMENT_WITH_EXPIRY_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])

-- TTL -1 means a counter exists without expiration (for example, one left by
-- the former two-command implementation after a connection failure). Repair
-- it in the same atomic script that increments the counter. TTL -2 is also
-- covered defensively, although INCR normally creates the key first.
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
  ttl = tonumber(ARGV[1])
end

return {count, ttl}
`;

export class RedisRateLimitStore implements RateLimitStore {
  constructor(
    private readonly failClosed = false,
    private readonly client: RedisRateLimitClient = redis,
  ) {}

  async increment(key: string, windowSeconds: number): Promise<RateLimitResult> {
    const redisKey = `ratelimit:${key}`;
    try {
      // N-5: script Lua retorna {count, ttl} — um único round-trip.
      const raw = await this.client.eval(
        INCREMENT_WITH_EXPIRY_SCRIPT,
        1,
        redisKey,
        windowSeconds,
      );
      // Redis retorna array como string no Bun (dependendo do client);
      // normalizamos para número(s).
      const arr = Array.isArray(raw) ? raw : [raw];
      const count = Number(arr[0]);
      const ttl = Number(arr[1] ?? windowSeconds);
      if (!Number.isSafeInteger(count) || count < 1) {
        throw new Error('Resposta inválida do Redis ao incrementar rate limit.');
      }
      return { count, ttl: Number.isSafeInteger(ttl) && ttl > 0 ? ttl : windowSeconds };
    } catch (err) {
      if (this.failClosed) {
        throw err;
      }
      // Fail-open (default): Redis offline → allow traffic (degraded).
      return { count: 0, ttl: windowSeconds };
    }
  }
}

// ─── Implementação em memória (testes) ───────────────────────────────────────

export class MemoryRateLimitStore implements RateLimitStore {
  private store = new Map<string, { count: number; resetAt: number }>();

  async increment(key: string, windowSeconds: number): Promise<RateLimitResult> {
    const now = Date.now();
    const entry = this.store.get(key);

    if (!entry || now > entry.resetAt) {
      this.store.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
      return { count: 1, ttl: windowSeconds };
    }

    entry.count++;
    const ttl = Math.max(0, Math.ceil((entry.resetAt - now) / 1000));
    return { count: entry.count, ttl };
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

    let result: RateLimitResult;
    try {
      result = await store.increment(rateLimitKey, windowSeconds);
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

    const current = result.count;
    const resetIn = result.ttl;
    const remaining = Math.max(0, effectiveLimit - current);

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
