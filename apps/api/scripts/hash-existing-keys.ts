/**
 * One-off backfill: computes key_hash for every existing api_keys row from
 * its still-plaintext `key` column. Safe to re-run (idempotent — only
 * updates rows where key_hash is null).
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { isNull, eq } from 'drizzle-orm';
import { db, closeDatabaseConnection } from '../src/infra/database/connection.ts';
import { apiKeys } from '../src/infra/database/schema.ts';

async function main(): Promise<void> {
  const rows = await db.select().from(apiKeys).where(isNull(apiKeys.keyHash));
  for (const row of rows) {
    const hash = createHash('sha256').update(row.key).digest('hex');
    await db.update(apiKeys).set({ keyHash: hash }).where(eq(apiKeys.id, row.id));
  }
  console.log(`✅ ${rows.length} key(s) hashed.`);
}

main()
  .catch((err) => {
    console.error('❌ Erro ao popular key_hash:', err);
    process.exit(1);
  })
  .finally(() => closeDatabaseConnection());
