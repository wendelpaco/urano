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
import { randomBytes, createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../src/infra/database/connection.ts';
import { apiKeys } from '../src/infra/database/schema.ts';
import { BOOTSTRAP_SCOPES } from '../src/infra/http/scopes.ts';

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
    const keyHash = createHash('sha256').update(key).digest('hex');
    const keyStored = `ur_hashonly_${keyHash.slice(0, 24)}`;

    const [row] = await db
      .insert(apiKeys)
      .values({
        name,
        key: keyStored,
        keyHash,
        scopes: [...BOOTSTRAP_SCOPES],
      })
      .returning();

    if (!row) {
      console.error('❌ Falha ao criar API key.');
      process.exit(1);
    }

    // Self-own bootstrap key (owner_id = id)
    await db.update(apiKeys).set({ ownerId: row.id }).where(eq(apiKeys.id, row.id));

    console.log(`🔑 API key criada: ${row.name}`);
    console.log(`   ${key}`);
    console.log(`   scopes: ${BOOTSTRAP_SCOPES.join(', ')}`);
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
