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

  RESEND_API_KEY: z.string().optional(),

  EMAIL_FROM: z
    .string()
    .default('Urano <noreply@urano.dev>'),

  DASHBOARD_URL: z
    .string()
    .default('http://localhost:3001'),

  STRIPE_SECRET_KEY: z.string().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().default(''),
  STRIPE_PRICE_PRO: z.string().default(''),
  STRIPE_PRICE_BUSINESS: z.string().default(''),
});

export type Env = z.infer<typeof envSchema>;

function parseEnv(): Env {
  const raw = {
    PORT: process.env.PORT,
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    EMAIL_FROM: process.env.EMAIL_FROM,
    DASHBOARD_URL: process.env.DASHBOARD_URL,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    STRIPE_PRICE_PRO: process.env.STRIPE_PRICE_PRO,
    STRIPE_PRICE_BUSINESS: process.env.STRIPE_PRICE_BUSINESS,
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
