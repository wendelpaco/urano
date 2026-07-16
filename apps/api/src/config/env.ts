import { z } from 'zod';

const isProd = process.env.NODE_ENV === 'production';

/**
 * Fastify/proxy-addr accepts an explicit IP/CIDR allow-list. `true` trusts any
 * X-Forwarded-* sender and therefore lets a directly exposed client spoof its
 * IP (including the identity used by rate limiting).
 */
export function parseTrustProxy(value: string): false | string[] {
  const normalized = value.trim();
  if (!normalized || normalized.toLowerCase() === 'false') return false;
  if (normalized.toLowerCase() === 'true') {
    throw new Error('TRUST_PROXY=true é inseguro; informe IPs/CIDRs explícitos');
  }

  const proxies = normalized.split(',').map((item) => item.trim()).filter(Boolean);
  if (proxies.length === 0) return false;
  return proxies;
}

/**
 * Em produção não aceitamos defaults com credenciais de dev — o processo
 * deve falhar cedo se DATABASE_URL / REDIS_URL não estiverem definidas.
 */
const envSchema = z.object({
  PORT: z
    .string()
    .default('3000')
    .transform(Number)
    .pipe(z.number().int().positive()),

  DATABASE_URL: isProd
    ? z.string().min(1, 'DATABASE_URL é obrigatória em produção')
    : z
        .string()
        .default('postgres://urano:urano_dev@localhost:5432/urano_finbot'),

  REDIS_URL: isProd
    ? z.string().min(1, 'REDIS_URL é obrigatória em produção')
    : z.string().default('redis://localhost:6379'),

  CORS_ORIGIN: z.string().default('http://localhost:8080'),

  // false (default) or comma-separated trusted proxy IPs/CIDRs.
  TRUST_PROXY: z
    .string()
    .default('false')
    .transform((value, ctx) => {
      try {
        return parseTrustProxy(value);
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: error instanceof Error ? error.message : 'TRUST_PROXY inválido',
        });
        return z.NEVER;
      }
    }),

  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Env strings are "true"/"false"; default keeps scheduler on in all envs.
  SCHEDULER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // When Redis rate-limit store fails: false = allow traffic (fail-open);
  // true = deny with 503 (fail-closed). Default TRUE in production, false in dev.
  RATE_LIMIT_FAIL_CLOSED: z
    .enum(['true', 'false'])
    .default(isProd ? 'true' : 'false')
    .transform((v) => v === 'true'),

  /** Pre-auth requests per IP/window. */
  RATE_LIMIT_IP_PER_MINUTE: z
    .string()
    .default('200')
    .transform(Number)
    .pipe(z.number().int().positive().max(100_000)),

  /** Authenticated requests per validated API key/window. */
  RATE_LIMIT_KEY_PER_MINUTE: z
    .string()
    .default('200')
    .transform(Number)
    .pipe(z.number().int().positive().max(100_000)),

  /** Scraper-touching routes per authenticated key/window (SSRF-2r). */
  SCRAPER_RATE_LIMIT_PER_MINUTE: z
    .string()
    .default('10')
    .transform(Number)
    .pipe(z.number().int().positive().max(1_000)),

  /** Public health probe requests per IP/window. */
  HEALTHCHECK_RATE_LIMIT_PER_MINUTE: z
    .string()
    .default('30')
    .transform(Number)
    .pipe(z.number().int().positive().max(1_000)),

  /** Max JSON body size in bytes (default 256 KiB). */
  BODY_LIMIT_BYTES: z
    .string()
    .default('262144')
    .transform(Number)
    .pipe(z.number().int().positive().max(5_000_000)),

  /** Postgres pool max connections (default 10). REL-3: aumente se houver contenção. */
  DATABASE_POOL_MAX: z
    .string()
    .default('10')
    .transform(Number)
    .pipe(z.number().int().min(2).max(100)),

  /** Request timeout ms (default 30s). */
  REQUEST_TIMEOUT_MS: z
    .string()
    .default('30000')
    .transform(Number)
    .pipe(z.number().int().positive().max(300_000)),
});

export type Env = z.infer<typeof envSchema>;

function parseEnv(): Env {
  const raw = {
    PORT: process.env.PORT,
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
    CORS_ORIGIN: process.env.CORS_ORIGIN,
    TRUST_PROXY: process.env.TRUST_PROXY,
    NODE_ENV: process.env.NODE_ENV,
    SCHEDULER_ENABLED: process.env.SCHEDULER_ENABLED,
    RATE_LIMIT_FAIL_CLOSED: process.env.RATE_LIMIT_FAIL_CLOSED,
    RATE_LIMIT_IP_PER_MINUTE: process.env.RATE_LIMIT_IP_PER_MINUTE,
    RATE_LIMIT_KEY_PER_MINUTE: process.env.RATE_LIMIT_KEY_PER_MINUTE,
    SCRAPER_RATE_LIMIT_PER_MINUTE: process.env.SCRAPER_RATE_LIMIT_PER_MINUTE,
    HEALTHCHECK_RATE_LIMIT_PER_MINUTE: process.env.HEALTHCHECK_RATE_LIMIT_PER_MINUTE,
    DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX,
    BODY_LIMIT_BYTES: process.env.BODY_LIMIT_BYTES,
    REQUEST_TIMEOUT_MS: process.env.REQUEST_TIMEOUT_MS,
  };

  const result = envSchema.safeParse(raw);

  if (!result.success) {
    console.error(
      '❌ Falha na validação das variáveis de ambiente:',
      JSON.stringify(result.error.format(), null, 2),
    );
    process.exit(1);
  }

  return result.data;
}

export const env = parseEnv();
