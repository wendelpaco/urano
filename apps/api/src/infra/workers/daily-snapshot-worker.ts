/**
 * Daily Snapshot Worker — Coleta snapshot diário de todos os ativos.
 *
 * Varre ações e FIIs, extrai TODOS os indicadores dos scrapers,
 * persiste no banco para treinamento de modelo preditivo.
 *
 * Executar: bun run src/infra/workers/daily-snapshot-worker.ts
 * Agenda: scheduler chama a cada 24h
 *
 * V2 (2026-07): batchWithConcurrency com rate limit centralizado.
 *               Sem setTimeout manual — o TokenBucket gerencia o espaçamento.
 */

import 'dotenv/config';
import { db } from '../database/connection.ts';
import { dailySnapshots, companies } from '../database/schema.ts';
import { statusInvestScraper } from '../services/statusinvest-scraper.ts';
import { fiisScraper } from '../services/fiis-scraper.ts';
import { batchWithConcurrency } from '../../shared/retry.ts';
import { isFii } from '../../shared/ticker-utils.ts';

// ─── Config ──────────────────────────────────────────────────────────────────

/** Concorrência máxima ao processar ativos (respeita rate limit do TokenBucket) */
const CONCURRENCY = 2;

async function snapshotStock(ticker: string): Promise<void> {
  const data = await statusInvestScraper.fetchStock(ticker);

  await db
    .insert(dailySnapshots)
    .values({
      ticker,
      assetType: 'stock',
      snapshotDate: new Date().toISOString().slice(0, 10),
      price: String(data.price),
      dy12m: String(data.dy12m),
      pl: String(data.pl),
      pvp: String(data.pvp),
      evEbitda: String(data.evEbitda),
      evEbit: String(data.evEbit),
      vpa: String(data.vpa),
      lpa: String(data.lpa),
      avgLiquidity: String(data.avgDailyLiquidity),
      roe: String(data.roe),
      roa: String(data.roa),
      roic: String(data.roic),
      grossMargin: String(data.grossMargin),
      ebitdaMargin: String(data.ebitdaMargin),
      ebitMargin: String(data.ebitMargin),
      netMargin: String(data.netMargin),
      cagrRevenue5y: data.cagrRevenue5y ? String(data.cagrRevenue5y) : null,
      cagrEarnings5y: data.cagrEarnings5y ? String(data.cagrEarnings5y) : null,
      netDebtToEquity: String(data.netDebtToEquity),
      netDebtToEbitda: String(data.netDebtToEbitda),
      currentRatio: String(data.currentRatio),
      assetTurnover: String(data.assetTurnover),
      source: 'statusinvest',
    })
    .onConflictDoUpdate({
      target: [dailySnapshots.ticker, dailySnapshots.snapshotDate],
      set: {
        price: String(data.price),
        dy12m: String(data.dy12m),
        pl: String(data.pl),
        pvp: String(data.pvp),
        roe: String(data.roe),
        roic: String(data.roic),
        netMargin: String(data.netMargin),
      },
    });

  console.log(`  ✅ ${ticker.padEnd(8)} P:${data.price} DY:${data.dy12m}% P/L:${data.pl} ROE:${data.roe}%`);
}

async function snapshotFII(ticker: string): Promise<void> {
  const data = await fiisScraper.fetchFII(ticker);

  await db
    .insert(dailySnapshots)
    .values({
      ticker,
      assetType: 'fii',
      snapshotDate: new Date().toISOString().slice(0, 10),
      price: String(data.price),
      dy12m: String(data.dy12m),
      pvp: String(data.pvp),
      bookValue: String(data.bookValue),
      min52w: String(data.min52w),
      max52w: String(data.max52w),
      valorization12m: String(data.valorization12m),
      volatility: String(data.volatility),
      avgLiquidity: String(0),
      roe: String(0),
      roa: String(0),
      roic: String(0),
      grossMargin: String(0),
      netMargin: String(0),
      dyCagr3y: data.dyCagr3y ? String(data.dyCagr3y) : null,
      valueCagr3y: data.valueCagr3y ? String(data.valueCagr3y) : null,
      avgMonthlyIncome: String(data.avgMonthlyIncome24m),
      numShareholders: data.numShareholders,
      cashValue: String(data.cashValue),
      ifixParticipation: data.ifixParticipation ? String(data.ifixParticipation) : null,
      source: 'statusinvest',
    })
    .onConflictDoUpdate({
      target: [dailySnapshots.ticker, dailySnapshots.snapshotDate],
      set: {
        price: String(data.price),
        dy12m: String(data.dy12m),
        pvp: String(data.pvp),
        bookValue: String(data.bookValue),
        avgMonthlyIncome: String(data.avgMonthlyIncome24m),
      },
    });

  console.log(`  ✅ ${ticker.padEnd(8)} P:${data.price} DY:${data.dy12m}% P/VP:${data.pvp}`);
}

async function main(): Promise<void> {
  const startTime = Date.now();
  console.log(`\n📸 Daily Snapshot — ${new Date().toISOString().slice(0, 10)}\n`);

  const allCompanies = await db
    .select({ ticker: companies.ticker })
    .from(companies)
    .orderBy(companies.ticker);

  const stocks = allCompanies.filter((c) => !isFii(c.ticker));
  const fiis = allCompanies.filter((c) => isFii(c.ticker));

  console.log(`📊 Ações: ${stocks.length} | FIIs: ${fiis.length}`);
  console.log(`⚡ Processando com concorrência ${CONCURRENCY} (rate limit gerenciado pelo TokenBucket)\n`);

  let stockSuccess = 0;
  let stockFailed = 0;

  // ── Ações (batch com concorrência controlada) ─────────────────────────
  console.log('─── Ações ───');
  const stockTickers = stocks.map((s) => s.ticker);
  await batchWithConcurrency(
    stockTickers,
    async (ticker) => {
      try {
        await snapshotStock(ticker);
        stockSuccess++;
      } catch (err) {
        stockFailed++;
        console.warn(`  ❌ ${ticker.padEnd(8)} ${(err as Error).message.slice(0, 60)}`);
      }
    },
    CONCURRENCY,
  );

  let fiiSuccess = 0;
  let fiiFailed = 0;

  // ── FIIs (batch com concorrência controlada) ──────────────────────────
  console.log('\n─── FIIs ───');
  const fiiTickers = fiis.map((f) => f.ticker);
  await batchWithConcurrency(
    fiiTickers,
    async (ticker) => {
      try {
        await snapshotFII(ticker);
        fiiSuccess++;
      } catch (err) {
        fiiFailed++;
        console.warn(`  ❌ ${ticker.padEnd(8)} ${(err as Error).message.slice(0, 60)}`);
      }
    },
    CONCURRENCY,
  );

  // Stats
  const [result] = await db.execute(
    `SELECT COUNT(*)::int as total, COUNT(DISTINCT ticker) as tickers
     FROM daily_snapshots WHERE snapshot_date = CURRENT_DATE`,
  );
  const stats = result as unknown as { total: number; tickers: number };

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`📊 Ações: ${stockSuccess}✅ ${stockFailed > 0 ? stockFailed + '❌' : ''}`);
  console.log(`📊 FIIs:  ${fiiSuccess}✅ ${fiiFailed > 0 ? fiiFailed + '❌' : ''}`);
  console.log(`💾 Snapshot: ${stats.total} registros de ${stats.tickers} ativos`);
  console.log(`⏱️  Tempo total: ${elapsed}s`);
  process.exit(0);
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
