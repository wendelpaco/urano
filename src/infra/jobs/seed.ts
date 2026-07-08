/**
 * Seed — Popula jobs de sincronização, setores e FIIs no banco.
 *
 * Executar uma vez após db:migrate + worker:sync:
 *   bun run src/infra/jobs/seed.ts
 *
 * Cria jobs para TODOS os tickers do banco (ações e FIIs).
 * Jobs são executados automaticamente pelo scheduler (server.ts).
 */

import 'dotenv/config';
import { db } from '../database/connection.ts';
import { companies } from '../database/schema.ts';
import { JobStore } from './job-store.ts';
import { eq, isNull } from 'drizzle-orm';

// ─── Config ──────────────────────────────────────────────────────────────────

const STOCK_INTERVAL = 21_600; // 6 horas
const FII_INTERVAL = 10_800;   // 3 horas

// ─── Seed ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('🌱 Iniciando seed...\n');

  const store = new JobStore();

  // 1. Busca todos os tickers do banco
  const allCompanies = await db
    .select({ ticker: companies.ticker, name: companies.name, sector: companies.sector })
    .from(companies)
    .orderBy(companies.ticker);

  const stocks = allCompanies.filter((c) => !c.ticker.endsWith('11'));
  const fiis = allCompanies.filter((c) => c.ticker.endsWith('11'));

  console.log(`📊 Encontrados: ${stocks.length} ações, ${fiis.length} FIIs\n`);

  // 2. Jobs de ações (scraping StatusInvest a cada 6h)
  console.log('📅 Criando jobs de ações...');
  let stockCount = 0;
  for (const s of stocks) {
    await store.createJob({
      ticker: s.ticker,
      assetType: 'stock',
      runInterval: STOCK_INTERVAL,
      priority: 0,
    });
    stockCount++;
  }
  console.log(`   ✅ ${stockCount} jobs criados (refresh a cada ${STOCK_INTERVAL / 3600}h)`);

  // 3. Jobs de FIIs (scraping StatusInvest a cada 3h)
  console.log('📅 Criando jobs de FIIs...');
  let fiiCount = 0;
  for (const f of fiis) {
    await store.createJob({
      ticker: f.ticker,
      assetType: 'fii',
      runInterval: FII_INTERVAL,
      priority: 1,
    });
    fiiCount++;
  }
  console.log(`   ✅ ${fiiCount} jobs criados (refresh a cada ${FII_INTERVAL / 3600}h)`);

  // 4. System job: snapshot diário
  await store.createJob({
    ticker: '_daily',
    assetType: 'system' as 'stock',
    runInterval: 86_400, // 24 horas
    priority: 10,
  });
  console.log('   ✅ 1 job de snapshot diário (24h)\n');

  // 5. Stats
  const stats = await store.getStats();
  console.log('📊 Status final:');
  console.log(`   Jobs: ${stats.jobs.total} total, ${stats.jobs.enabled} ativos`);
  console.log(`   Runs: ${stats.runs.total} total`);

  console.log('\n✅ Seed concluído! O scheduler (server.ts) vai executar automaticamente.');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Seed falhou:', err);
  process.exit(1);
});
