import { z } from 'zod';

const envSchema = z.object({
  PORT: z
    .string()
    .default('3000')
    .transform(Number)
    .pipe(z.number().int().positive()),

  DATABASE_URL: z
    .string()
    .default('postgres://urano:urano_dev@localhost:5432/urano_finbot'),

  REDIS_URL: z
    .string()
    .default('redis://localhost:6379'),
});

export type Env = z.infer<typeof envSchema>;

function parseEnv(): Env {
  const raw = {
    PORT: process.env.PORT,
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
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
