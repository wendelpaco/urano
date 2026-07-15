import { z } from 'zod';

const isProd = process.env.NODE_ENV === 'production';

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

  /** Max JSON body size in bytes (default 256 KiB). */
  BODY_LIMIT_BYTES: z
    .string()
    .default('262144')
    .transform(Number)
    .pipe(z.number().int().positive().max(5_000_000)),

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
    NODE_ENV: process.env.NODE_ENV,
    SCHEDULER_ENABLED: process.env.SCHEDULER_ENABLED,
    RATE_LIMIT_FAIL_CLOSED: process.env.RATE_LIMIT_FAIL_CLOSED,
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
