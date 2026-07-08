/**
 * Seed — Popula jobs iniciais, setores e FIIs no banco.
 *
 * Executar uma vez após db:migrate:
 *   bun run src/infra/jobs/seed.ts
 */

import 'dotenv/config';
import { db } from '../database/connection.ts';
import { companies } from '../database/schema.ts';
import { JobStore } from './job-store.ts';
import { eq } from 'drizzle-orm';

// ─── Setores das empresas B3 ────────────────────────────────────────────────

const SECTOR_MAP: Record<string, string> = {
  PETR4: 'Petróleo e Gás',
  VALE3: 'Mineração',
  ITUB4: 'Financeiro',
  BBDC4: 'Financeiro',
  BBAS3: 'Financeiro',
  SANB11: 'Financeiro',
  GGBR4: 'Siderurgia',
  CSNA3: 'Mineração',
  USIM5: 'Siderurgia',
  ELET3: 'Energia Elétrica',
  CPLE6: 'Energia Elétrica',
  EGIE3: 'Energia Elétrica',
  PRIO3: 'Petróleo e Gás',
  SUZB3: 'Papel e Celulose',
  KLBN11: 'Papel e Celulose',
  ABEV3: 'Bebidas',
  JBSS3: 'Alimentos',
  MGLU3: 'Varejo',
  HAPV3: 'Saúde',
  WEGE3: 'Bens Industriais',
  EMBR3: 'Aviação',
  VIVT3: 'Telecomunicações',
  TIMS3: 'Telecomunicações',
  RAIL3: 'Transporte',
  CCRO3: 'Transporte',
  CYRE3: 'Construção',
  MULT3: 'Imobiliário',
};

// ─── FIIs a cadastrar ───────────────────────────────────────────────────────

const FII_LIST: Array<{ ticker: string; name: string; sector: string }> = [
  { ticker: 'HGLG11', name: 'CSHG Logística FII', sector: 'Logística' },
  { ticker: 'XPML11', name: 'XP Malls FII', sector: 'Shopping' },
  { ticker: 'KNCR11', name: 'Kinea Rendimentos Imobiliários FII', sector: 'Papel' },
  { ticker: 'MXRF11', name: 'Maxi Renda FII', sector: 'Papel' },
  { ticker: 'VGIR11', name: 'Valora CRI FII', sector: 'Papel' },
  { ticker: 'BCFF11', name: 'BTG Pactual Fundo de Fundos', sector: 'Papel' },
  { ticker: 'VCRI11', name: 'Valora CRI CDI FII', sector: 'Papel' },
  { ticker: 'RBRF11', name: 'RB Capital Renda FII', sector: 'Papel' },
  { ticker: 'VISC11', name: 'Vinci Shopping Centers FII', sector: 'Shopping' },
  { ticker: 'BRCO11', name: 'Bresco Logística FII', sector: 'Logística' },
  { ticker: 'LVBI11', name: 'VBI Logística FII', sector: 'Logística' },
  { ticker: 'RZTR11', name: 'Riza Terrax FII', sector: 'Logística' },
  { ticker: 'VILG11', name: 'Vinci Logística FII', sector: 'Logística' },
  { ticker: 'GALG11', name: 'Guardian Logística FII', sector: 'Logística' },
  { ticker: 'BTLG11', name: 'BTG Pactual Logística FII', sector: 'Logística' },
  { ticker: 'PVBI11', name: 'VBI Prime Properties FII', sector: 'Logística' },
  { ticker: 'ALZR11', name: 'Alianza Trust Renda FII', sector: 'Logística' },
  { ticker: 'XPLG11', name: 'XP Log FII', sector: 'Logística' },
  { ticker: 'TGAR11', name: 'TG Ativo Real FII', sector: 'Agronegócio' },
  { ticker: 'HGRE11', name: 'CSHG Real Estate FII', sector: 'Lajes Corporativas' },
  { ticker: 'HGRU11', name: 'CSHG Renda Urbana FII', sector: 'Lajes Corporativas' },
  { ticker: 'HGBS11', name: 'Hedge Brasil Shopping FII', sector: 'Shopping' },
  { ticker: 'CPTS11', name: 'Capitânia Securities II FII', sector: 'Papel' },
  { ticker: 'KNRI11', name: 'Kinea Renda Imobiliária FII', sector: 'Híbrido' },
  { ticker: 'RECT11', name: 'REC Recebíveis Imobiliários FII', sector: 'Papel' },
  { ticker: 'RBVA11', name: 'RB Capital Renda II FII', sector: 'Papel' },
  { ticker: 'JSRE11', name: 'JS Real Estate FII', sector: 'Lajes Corporativas' },
  { ticker: 'RBRR11', name: 'RB Capital Renda III FII', sector: 'Papel' },
  { ticker: 'GGRC11', name: 'GGR Covepi Renda FII', sector: 'Logística' },
  { ticker: 'TRXF11', name: 'TRX Real Estate FII', sector: 'Híbrido' },
];

// ─── Seed ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('🌱 Iniciando seed...\n');

  // 1. Atualiza setores
  console.log('📌 Atualizando setores...');
  let sectorCount = 0;
  for (const [ticker, sector] of Object.entries(SECTOR_MAP)) {
    await db
      .update(companies)
      .set({ sector })
      .where(eq(companies.ticker, ticker));
    sectorCount++;
  }
  console.log(`   ✅ ${sectorCount} setores atualizados\n`);

  // 2. Cadastra FIIs
  console.log('🏢 Cadastrando FIIs...');
  let fiiCount = 0;
  for (const fii of FII_LIST) {
    // Gera um CNPJ fake para FIIs (14 chars, formato FII + ticker + zeros)
    const fakeCnpj = `FII${fii.ticker.padEnd(11, '0').slice(0, 11)}`;
    await db
      .insert(companies)
      .values({
        cnpj: fakeCnpj,
        ticker: fii.ticker,
        name: fii.name,
        sector: fii.sector,
      })
      .onConflictDoUpdate({
        target: companies.ticker,
        set: { name: fii.name, sector: fii.sector, updatedAt: new Date() },
      });
    fiiCount++;
  }
  console.log(`   ✅ ${fiiCount} FIIs cadastrados\n`);

  // 3. Cria jobs para todas as ações
  console.log('📅 Criando jobs de sincronização...');
  const store = new JobStore();

  // Ações: refresh a cada 6 horas (proventos + cotação)
  let stockJobCount = 0;
  for (const ticker of Object.keys(SECTOR_MAP)) {
    await store.createJob({
      ticker,
      assetType: 'stock',
      runInterval: 21_600, // 6 horas
      priority: 0,
    });
    stockJobCount++;
  }
  console.log(`   ✅ ${stockJobCount} jobs de ações (6h)`);

  // FIIs: refresh a cada 3 horas (proventos + P/VP + cotação)
  let fiiJobCount = 0;
  for (const fii of FII_LIST) {
    await store.createJob({
      ticker: fii.ticker,
      assetType: 'fii',
      runInterval: 10_800, // 3 horas
      priority: 1,
    });
    fiiJobCount++;
  }
  console.log(`   ✅ ${fiiJobCount} jobs de FIIs (3h)\n`);

  // 4. Stats
  const stats = await store.getStats();
  console.log('📊 Status final:');
  console.log(`   Jobs: ${stats.jobs.total} total, ${stats.jobs.enabled} ativos`);
  console.log(`   Runs: ${stats.runs.total} total, ${stats.runs.last_24h} nas últimas 24h`);

  console.log('\n✅ Seed concluído!');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Seed falhou:', err);
  process.exit(1);
});
