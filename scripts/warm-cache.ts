/**
 * Cache Warming — Precomputa scores dos principais tickers.
 *
 * Popula o Redis com análises prontas para reduzir cold starts.
 * Rode via cron ou após deploy: bun run warm-cache
 *
 * Uso:
 *   bun run warm-cache                # todos os tickers padrão
 *   bun run warm-cache stocks         # só ações
 *   bun run warm-cache fiis           # só FIIs
 */

import 'dotenv/config';

const API_BASE = process.env.URANO_API_URL || 'http://localhost:3000/v1';

async function warm(url: string, label: string): Promise<void> {
  try {
    const key = process.env.URANO_API_KEY || 'dev';
    const start = performance.now();
    const r = await fetch(`${API_BASE}${url}`, {
      headers: { 'x-api-key': key },
    });
    const elapsed = ((performance.now() - start) / 1000).toFixed(2);
    if (r.ok) {
      console.log(`  ✅ ${label.padEnd(10)} ${elapsed}s`);
    } else {
      console.log(`  ⚠️  ${label.padEnd(10)} HTTP ${r.status} (${elapsed}s)`);
    }
  } catch (err) {
    console.log(`  ❌ ${label.padEnd(10)} ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Principais tickers ──────────────────────────────────────────────────────

const STOCKS = [
  'PETR4', 'VALE3', 'ITUB4', 'BBDC4', 'BBAS3', 'WEGE3', 'ABEV3',
  'ELET3', 'RENT3', 'SUZB3', 'PRIO3', 'EQTL3', 'GGBR4', 'EMBR3',
  'RADL3', 'TOTS3', 'VIVT3', 'CPLE6', 'EGIE3', 'LREN3',
];

const FIIS = [
  'HGLG11', 'KNCR11', 'XPLG11', 'XPML11', 'VISC11', 'MXRF11',
  'KNRI11', 'BCFF11', 'HGRU11', 'BTLG11', 'HGRE11', 'KNIP11',
  'VGIR11', 'IRDM11', 'RZTR11', 'TRXF11', 'MALL11', 'HSML11',
];

// ─── Main ────────────────────────────────────────────────────────────────────

const mode = process.argv[2] || 'all';

async function main(): Promise<void> {
  console.log(`🔥 Cache warming — ${mode === 'all' ? 'ações + FIIs' : mode}`);
  console.log(`   API: ${API_BASE}\n`);

  const startTotal = performance.now();

  if (mode === 'all' || mode === 'stocks') {
    console.log('📈 Ações:');
    for (const ticker of STOCKS) {
      await warm(`/analysis/stocks/${ticker}`, ticker);
    }
  }

  if (mode === 'all' || mode === 'fiis') {
    console.log('\n🏢 FIIs:');
    for (const ticker of FIIS) {
      await warm(`/analysis/fiis/${ticker}`, ticker);
    }
  }

  // Rankings
  console.log('\n🏆 Rankings:');
  await warm('/analysis/ranking?type=stock&limit=10', 'stocks top10');
  await warm('/analysis/ranking?type=fii&limit=10', 'fiis top10');

  // Screener (cache genérico)
  console.log('\n🔍 Screeners:');
  await warm('/screener?minScore=50&sortBy=roe&limit=10', 'score>50');
  await warm('/fiis/screener?dy_gte=8&sort=dy&limit=10', 'fii dy>8%');

  const totalElapsed = ((performance.now() - startTotal) / 1000).toFixed(2);
  console.log(`\n✅ Cache warming concluído em ${totalElapsed}s`);
  process.exit(0);
}

main();
