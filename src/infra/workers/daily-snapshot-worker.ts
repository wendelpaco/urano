/**
 * Daily Snapshot Worker — Coleta snapshot diário de todos os ativos.
 *
 * Varre ações e FIIs, extrai TODOS os indicadores dos scrapers,
 * persiste no banco para treinamento de modelo preditivo.
 *
 * Executar: bun run src/infra/workers/daily-snapshot-worker.ts
 * Agenda: scheduler chama a cada 24h
 */

import 'dotenv/config';
import { db } from '../database/connection.ts';
import { dailySnapshots, companies } from '../database/schema.ts';
import { statusInvestScraper, type ScrapedIndicators } from '../services/statusinvest-scraper.ts';
import { fiisScraper, type FiisData } from '../services/fiis-scraper.ts';
import { eq } from 'drizzle-orm';

async function snapshotStock(ticker: string): Promise<void> {
  try {
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
  } catch (err) {
    console.warn(`  ❌ ${ticker.padEnd(8)} ${(err as Error).message.slice(0, 60)}`);
  }
}

async function snapshotFII(ticker: string): Promise<void> {
  try {
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
  } catch (err) {
    console.warn(`  ❌ ${ticker.padEnd(8)} ${(err as Error).message.slice(0, 60)}`);
  }
}

async function main(): Promise<void> {
  console.log(`\n📸 Daily Snapshot — ${new Date().toISOString().slice(0, 10)}\n`);

  const allCompanies = await db
    .select({ ticker: companies.ticker })
    .from(companies)
    .orderBy(companies.ticker);

  const stocks = allCompanies.filter((c) => !c.ticker.endsWith('11'));
  const fiis = allCompanies.filter((c) => c.ticker.endsWith('11'));

  console.log(`📊 Ações: ${stocks.length} | FIIs: ${fiis.length}\n`);

  // Ações
  console.log('─── Ações ───');
  for (let i = 0; i < stocks.length; i++) {
    await snapshotStock(stocks[i]!.ticker);
    // Rate limit: 1.5 req/s = ~667ms entre chamadas
    if (i < stocks.length - 1) await new Promise((r) => setTimeout(r, 800));
  }

  // FIIs
  console.log('\n─── FIIs ───');
  for (let i = 0; i < fiis.length; i++) {
    await snapshotFII(fiis[i]!.ticker);
    if (i < fiis.length - 1) await new Promise((r) => setTimeout(r, 800));
  }

  // Stats
  const [result] = await db.execute(
    `SELECT COUNT(*)::int as total, COUNT(DISTINCT ticker) as tickers
     FROM daily_snapshots WHERE snapshot_date = CURRENT_DATE`,
  );
  const stats = result as unknown as { total: number; tickers: number };

  console.log(`\n✅ Snapshot concluído: ${stats.total} registros de ${stats.tickers} ativos`);
  process.exit(0);
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
