/**
 * Bootstrap CLI — Cria a primeira API key (ou keys adicionais).
 *
 * Uso:
 *   bun run key:create [nome]
 *
 * Sem auth configurado, o sistema fica trancado (toda rota exige x-api-key).
 * Este script resolve o bootstrap inicial e também serve para criar chaves
 * adicionais em produção.
 */

import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { db } from '../src/infra/database/connection.ts';
import { apiKeys } from '../src/infra/database/schema.ts';

const name = process.argv[2] ?? 'default';

/** Gera key com CSPRNG — entropia de 192 bits (48 hex chars) */
function generateApiKey(): string {
  const segments = Array.from({ length: 4 }, () =>
    randomBytes(6).toString('hex'),
  );
  return `ur_${segments.join('_')}`;
}

async function main(): Promise<void> {
  try {
    const key = generateApiKey();

    const [row] = await db
      .insert(apiKeys)
      .values({ name, key })
      .returning();

    if (!row) {
      console.error('❌ Falha ao criar API key.');
      process.exit(1);
    }

    console.log(`🔑 API key criada: ${row.name}`);
    console.log(`   ${row.key}`);
    console.log('');
    console.log('⚠️  Guarde esta chave — ela não será exibida novamente.');
    console.log('   Use no header: x-api-key');
  } catch (err) {
    console.error('❌ Erro ao criar API key:', err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

main();
