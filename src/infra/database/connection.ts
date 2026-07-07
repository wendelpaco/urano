import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../../config/env.ts';
import * as schema from './schema.ts';

/**
 * Cliente PostgreSQL via Drizzle ORM.
 *
 * Utiliza o driver `postgres` (baixo overhead) como transporte,
 * com Drizzle fornecendo type-safety nas queries e schema management.
 */
const pgClient = postgres(env.DATABASE_URL, {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 10,
});

export const db = drizzle(pgClient, { schema });

/**
 * Verifica a conectividade com o banco.
 * Lança erro se não conseguir conectar, permitindo fail-fast na inicialização.
 */
export async function checkDatabaseConnection(): Promise<void> {
  try {
    const result = await db.execute('SELECT 1 AS ok');
    console.log('[Database] ✅ Conexão com PostgreSQL estabelecida (Drizzle ORM)');
  } catch (error) {
    console.error(
      '[Database] ❌ Falha ao conectar ao PostgreSQL:',
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}

/**
 * Encerra o pool de conexões graciosamente.
 * Deve ser chamado no shutdown da aplicação.
 */
export async function closeDatabaseConnection(): Promise<void> {
  await pgClient.end();
  console.log('[Database] Pool de conexões encerrado');
}
