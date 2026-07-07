import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/infra/database/schema.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  // Opções de geração
  strict: true,
  verbose: true,
});
