/**
 * Seed — Popula jobs de sincronização, setores e FIIs no banco.
 *
 * Executar uma vez após db:migrate + worker:sync:
 *   bun run seed
 *
 * Idempotente: pode rodar múltiplas vezes, não duplica dados.
 */

import 'dotenv/config';
import { db } from '../database/connection.ts';
import { companies } from '../database/schema.ts';
import { JobStore } from './job-store.ts';

// ─── Config ──────────────────────────────────────────────────────────────────

const STOCK_INTERVAL = 21_600; // 6 horas
const FII_INTERVAL = 10_800;   // 3 horas

// ─── FIIs conhecidos (mesma lista do controller) ────────────────────────────
const KNOWN_FIIS: Array<{ ticker: string; name: string; sector: string }> = [
  { ticker: 'HGLG11', name: 'CSHG Logística FII', sector: 'Logística' },
  { ticker: 'XPLG11', name: 'XP Log FII', sector: 'Logística' },
  { ticker: 'BTLG11', name: 'BTG Pactual Logística FII', sector: 'Logística' },
  { ticker: 'VILG11', name: 'Vinci Logística FII', sector: 'Logística' },
  { ticker: 'LVBI11', name: 'VBI Logístico FII', sector: 'Logística' },
  { ticker: 'KNRI11', name: 'Kinea Renda Imobiliária FII', sector: 'Lajes Corporativas' },
  { ticker: 'RCRB11', name: 'Rio Bravo Renda Corporativa FII', sector: 'Lajes Corporativas' },
  { ticker: 'HGRE11', name: 'CSHG Real Estate FII', sector: 'Lajes Corporativas' },
  { ticker: 'BRCR11', name: 'BTG Pactual Corporate Office Fund FII', sector: 'Lajes Corporativas' },
  { ticker: 'VISC11', name: 'Vinci Shopping Centers FII', sector: 'Shopping' },
  { ticker: 'XPML11', name: 'XP Malls FII', sector: 'Shopping' },
  { ticker: 'MALL11', name: 'Malls Brasil Plural FII', sector: 'Shopping' },
  { ticker: 'HSML11', name: 'Hedge Shopping Malls FII', sector: 'Shopping' },
  { ticker: 'KNIP11', name: 'Kinea Índice de Preços FII', sector: 'Títulos e Valores Mobiliários' },
  { ticker: 'KNCR11', name: 'Kinea Rendimentos Imobiliários FII', sector: 'Títulos e Valores Mobiliários' },
  { ticker: 'MXRF11', name: 'Maxi Renda FII', sector: 'Títulos e Valores Mobiliários' },
  { ticker: 'VGIR11', name: 'Valora CRI Índice de Preço FII', sector: 'Títulos e Valores Mobiliários' },
  { ticker: 'IRDM11', name: 'Iridium Recebíveis Imobiliários FII', sector: 'Títulos e Valores Mobiliários' },
  { ticker: 'URPR11', name: 'Urca Prime Renda FII', sector: 'Títulos e Valores Mobiliários' },
  { ticker: 'CPTS11', name: 'Capitânia Securities II FII', sector: 'Títulos e Valores Mobiliários' },
  { ticker: 'RECR11', name: 'REC Recebíveis Imobiliários FII', sector: 'Títulos e Valores Mobiliários' },
  { ticker: 'DEVA11', name: 'Devant Recebíveis Imobiliários FII', sector: 'Títulos e Valores Mobiliários' },
  { ticker: 'RBRR11', name: 'RBR Rendimento High Grade FII', sector: 'Títulos e Valores Mobiliários' },
  { ticker: 'BCFF11', name: 'BTG Pactual Fundo de Fundos FII', sector: 'FoF' },
  { ticker: 'KISU11', name: 'Kinea FOF FII', sector: 'FoF' },
  { ticker: 'ITIP11', name: 'Itaú FOF Renda Imobiliária FII', sector: 'FoF' },
  { ticker: 'HGRU11', name: 'CSHG Renda Urbana FII', sector: 'Renda Urbana' },
  { ticker: 'TRXF11', name: 'TRX Real Estate FII', sector: 'Renda Urbana' },
  { ticker: 'RZTR11', name: 'Riza Terrax FII', sector: 'Agro' },
  { ticker: 'SNAG11', name: 'Suno Agro FII', sector: 'Agro' },
  { ticker: 'VGIP11', name: 'Valora CRI FII', sector: 'Títulos e Valores Mobiliários' },
  { ticker: 'GARE11', name: 'Guardian Logística FII', sector: 'Logística' },
  { ticker: 'PATL11', name: 'Pátria Logístico FII', sector: 'Logística' },
];

const FII_TICKER_SET = new Set(KNOWN_FIIS.map((f) => f.ticker));

// ─── Seed ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('🌱 Iniciando seed...\n');

  const store = new JobStore();

  // 1. Cadastra FIIs (idempotente via ON CONFLICT)
  console.log('🏢 Cadastrando FIIs...');
  let fiiAdded = 0;
  for (const fii of KNOWN_FIIS) {
    const fakeCnpj = `FII${fii.ticker.padEnd(11, '0').slice(0, 11)}`;
    await db
      .insert(companies)
      .values({ cnpj: fakeCnpj, ticker: fii.ticker, name: fii.name, sector: fii.sector })
      .onConflictDoUpdate({ target: companies.ticker, set: { name: fii.name, sector: fii.sector, updatedAt: new Date() } });
    fiiAdded++;
  }
  console.log(`   ✅ ${fiiAdded} FIIs cadastrados\n`);

  // 2. Lê todas as empresas do banco
  const allCompanies = await db
    .select({ ticker: companies.ticker, name: companies.name })
    .from(companies)
    .orderBy(companies.ticker);

  const stocks = allCompanies.filter((c) => !FII_TICKER_SET.has(c.ticker));
  const fiis = allCompanies.filter((c) => FII_TICKER_SET.has(c.ticker));

  console.log(`📊 ${stocks.length} ações, ${fiis.length} FIIs\n`);

  // 3. Jobs de ações (StatusInvest a cada 6h)
  console.log('📅 Criando jobs de ações...');
  for (const s of stocks) {
    await store.createJob({ ticker: s.ticker, assetType: 'stock', runInterval: STOCK_INTERVAL, priority: 1 });
  }
  console.log(`   ✅ ${stocks.length} jobs (refresh a cada ${STOCK_INTERVAL / 3600}h)`);

  // 4. Jobs de FIIs (StatusInvest a cada 3h)
  console.log('📅 Criando jobs de FIIs...');
  for (const f of fiis) {
    await store.createJob({ ticker: f.ticker, assetType: 'fii', runInterval: FII_INTERVAL, priority: 1 });  // mesma prioridade = intercala
  }
  console.log(`   ✅ ${fiis.length} jobs (refresh a cada ${FII_INTERVAL / 3600}h)`);

  // 5. System job: snapshot diário
  await store.createJob({ ticker: '_daily', assetType: 'system' as 'stock', runInterval: 86_400, priority: 10 });
  console.log('   ✅ 1 job de snapshot diário (24h)\n');

  // 6. Stats
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
