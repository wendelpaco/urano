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

// ─── FIIs conhecidos (mesma lista do controller) ────────────────────────────
const KNOWN_FIIS: Array<{ ticker: string; name: string; sector: string; admin: string }> = [
  { ticker: 'HGLG11', name: 'CSHG Logística FII', sector: 'Logística', admin: 'Credit Suisse' },
  { ticker: 'XPLG11', name: 'XP Log FII', sector: 'Logística', admin: 'XP Asset' },
  { ticker: 'BTLG11', name: 'BTG Pactual Logística FII', sector: 'Logística', admin: 'BTG Pactual' },
  { ticker: 'VILG11', name: 'Vinci Logística FII', sector: 'Logística', admin: 'Vinci Partners' },
  { ticker: 'LVBI11', name: 'VBI Logístico FII', sector: 'Logística', admin: 'VBI Real Estate' },
  { ticker: 'KNRI11', name: 'Kinea Renda Imobiliária FII', sector: 'Lajes Corporativas', admin: 'Kinea' },
  { ticker: 'RCRB11', name: 'Rio Bravo Renda Corporativa FII', sector: 'Lajes Corporativas', admin: 'Rio Bravo' },
  { ticker: 'HGRE11', name: 'CSHG Real Estate FII', sector: 'Lajes Corporativas', admin: 'Credit Suisse' },
  { ticker: 'BRCR11', name: 'BTG Pactual Corporate Office Fund FII', sector: 'Lajes Corporativas', admin: 'BTG Pactual' },
  { ticker: 'VISC11', name: 'Vinci Shopping Centers FII', sector: 'Shopping', admin: 'Vinci Partners' },
  { ticker: 'XPML11', name: 'XP Malls FII', sector: 'Shopping', admin: 'XP Asset' },
  { ticker: 'MALL11', name: 'Malls Brasil Plural FII', sector: 'Shopping', admin: 'Plural Gestão' },
  { ticker: 'HSML11', name: 'Hedge Shopping Malls FII', sector: 'Shopping', admin: 'Hedge Investments' },
  { ticker: 'KNIP11', name: 'Kinea Índice de Preços FII', sector: 'Títulos e Valores Mobiliários', admin: 'Kinea' },
  { ticker: 'KNCR11', name: 'Kinea Rendimentos Imobiliários FII', sector: 'Títulos e Valores Mobiliários', admin: 'Kinea' },
  { ticker: 'MXRF11', name: 'Maxi Renda FII', sector: 'Títulos e Valores Mobiliários', admin: 'BTG Pactual' },
  { ticker: 'VGIR11', name: 'Valora CRI Índice de Preço FII', sector: 'Títulos e Valores Mobiliários', admin: 'Valora' },
  { ticker: 'IRDM11', name: 'Iridium Recebíveis Imobiliários FII', sector: 'Títulos e Valores Mobiliários', admin: 'Iridium' },
  { ticker: 'URPR11', name: 'Urca Prime Renda FII', sector: 'Títulos e Valores Mobiliários', admin: 'Urca' },
  { ticker: 'CPTS11', name: 'Capitânia Securities II FII', sector: 'Títulos e Valores Mobiliários', admin: 'Capitânia' },
  { ticker: 'RECR11', name: 'REC Recebíveis Imobiliários FII', sector: 'Títulos e Valores Mobiliários', admin: 'REC Gestão' },
  { ticker: 'DEVA11', name: 'Devant Recebíveis Imobiliários FII', sector: 'Títulos e Valores Mobiliários', admin: 'Devant' },
  { ticker: 'RBRR11', name: 'RBR Rendimento High Grade FII', sector: 'Títulos e Valores Mobiliários', admin: 'RBR Asset' },
  { ticker: 'BCFF11', name: 'BTG Pactual Fundo de Fundos FII', sector: 'FoF', admin: 'BTG Pactual' },
  { ticker: 'KISU11', name: 'Kinea FOF FII', sector: 'FoF', admin: 'Kinea' },
  { ticker: 'ITIP11', name: 'Itaú FOF Renda Imobiliária FII', sector: 'FoF', admin: 'Itaú Asset' },
  { ticker: 'HGRU11', name: 'CSHG Renda Urbana FII', sector: 'Renda Urbana', admin: 'Credit Suisse' },
  { ticker: 'TRXF11', name: 'TRX Real Estate FII', sector: 'Renda Urbana', admin: 'TRX Gestão' },
  { ticker: 'RZTR11', name: 'Riza Terrax FII', sector: 'Agro', admin: 'Riza Asset' },
  { ticker: 'SNAG11', name: 'Suno Agro FII', sector: 'Agro', admin: 'Suno Asset' },
  { ticker: 'VGIP11', name: 'Valora CRI FII', sector: 'Títulos e Valores Mobiliários', admin: 'Valora' },
  { ticker: 'GARE11', name: 'Guardian Logística FII', sector: 'Logística', admin: 'Guardian Asset' },
  { ticker: 'PATL11', name: 'Pátria Logístico FII', sector: 'Logística', admin: 'Pátria' },
];

// ─── Config ──────────────────────────────────────────────────────────────────

const STOCK_INTERVAL = 21_600; // 6 horas
const FII_INTERVAL = 10_800;   // 3 horas

// ─── Seed ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('🌱 Iniciando seed...\n');

  const store = new JobStore();

  // 1. Busca todos os tickers do banco
  const initialCompanies = await db
    .select({ ticker: companies.ticker, name: companies.name, sector: companies.sector })
    .from(companies)
    .orderBy(companies.ticker);

  const initialStocks = initialCompanies.filter((c) => !c.ticker.endsWith('11'));
  const initialFiis = initialCompanies.filter((c) => c.ticker.endsWith('11'));

  console.log(`📊 Encontrados: ${initialStocks.length} ações, ${initialFiis.length} FIIs\n`);

  // 1.5. Garante que todos os FIIs conhecidos estão cadastrados
  if (initialFiis.length < KNOWN_FIIS.length) {
    console.log('🏢 Cadastrando FIIs faltantes...');
    const existingTickers = new Set(initialFiis.map((f) => f.ticker));
    let added = 0;
    for (const fii of KNOWN_FIIS) {
      if (!existingTickers.has(fii.ticker)) {
        const fakeCnpj = `FII${fii.ticker.padEnd(11, '0').slice(0, 11)}`;
        await db
          .insert(companies)
          .values({ cnpj: fakeCnpj, ticker: fii.ticker, name: fii.name, sector: fii.sector })
          .onConflictDoUpdate({ target: companies.ticker, set: { name: fii.name, sector: fii.sector, updatedAt: new Date() } });
        added++;
      }
    }
    console.log(`   ✅ ${added} FIIs cadastrados`);
  }

  // 2. Recarrega a lista completa (inclui FIIs recém-cadastrados)
  const allCompanies = await db
    .select({ ticker: companies.ticker, name: companies.name })
    .from(companies)
    .orderBy(companies.ticker);

  const allStocks = allCompanies.filter((c) => !c.ticker.endsWith('11'));
  const allFiis = allCompanies.filter((c) => c.ticker.endsWith('11'));

  // 3. Jobs de ações (scraping StatusInvest a cada 6h)
  console.log('📅 Criando jobs de ações...');
  let stockCount = 0;
  for (const s of allStocks) {
    await store.createJob({
      ticker: s.ticker,
      assetType: 'stock',
      runInterval: STOCK_INTERVAL,
      priority: 0,
    });
    stockCount++;
  }
  console.log(`   ✅ ${stockCount} jobs criados (refresh a cada ${STOCK_INTERVAL / 3600}h)`);

  // 4. Jobs de FIIs (scraping StatusInvest a cada 3h)
  console.log('📅 Criando jobs de FIIs...');
  let fiiCount = 0;
  for (const f of allFiis) {
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
