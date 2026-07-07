import { z } from 'zod';

const envSchema = z.object({
  PORT: z
    .string()
    .default('3000')
    .transform(Number)
    .pipe(z.number().int().positive()),
});

export type Env = z.infer<typeof envSchema>;

function parseEnv(): Env {
  const raw = {
    PORT: process.env.PORT,
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
