#!/usr/bin/env bun
/**
 * Backtest FII — total return real (cota Yahoo + proventos StatusInvest/DB).
 *
 * Para cada FII da lista mestra e cada ano civil:
 *   total return = variação de cota + proventos / preço início
 *
 * Também testa se DY do ano Y prediz total return do ano Y+1.
 * Score atual (quando calculável) é gravado só como metadado — NÃO é look-ahead free
 * para ranking histórico; a correlação DY→TR seguinte sim é look-ahead free.
 *
 * Uso:
 *   bun run backtest:fii
 *   bun run backtest:fii 2020 2024
 *   bun run backtest:fii --tickers=HGLG11,KNCR11,XPML11
 */

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { ALL_FII_TICKERS } from '../../shared/tickers-master-list.ts';
import { stockQuoteService } from '../services/stock-quote-service.ts';
import { dividendsProvider } from '../services/dividends-provider.ts';
import { cvmFiiService } from '../services/cvm-fii-service.ts';
import { db, closeDatabaseConnection } from '../database/connection.ts';
import { fiiBacktestYears, fiiBacktestDyPairs } from '../database/schema.ts';
import {
  calendarYearTotalReturns,
  trailingDyAndNextTotalReturn,
} from '../../core/services/total-return.ts';
import {
  averageTotalReturnByYear,
  dyPredictsNextReturn,
  topNByScoreVsUniverse,
  type FiiYearRow,
} from '../../core/services/fii-backtest-analysis.ts';
import {
  FIIScoreCalculatorV4,
  type FIIScoreInput,
} from '../../core/services/fii-score.ts';

function parseArgs() {
  const args = process.argv.slice(2);
  let years: number[] = [];
  let tickers = [...ALL_FII_TICKERS];

  for (const a of args) {
    if (a.startsWith('--tickers=')) {
      tickers = a
        .slice('--tickers='.length)
        .split(',')
        .map((t) => t.trim().toUpperCase())
        .filter(Boolean);
    } else if (/^\d{4}$/.test(a)) {
      years.push(Number(a));
    } else if (/^\d{4}-\d{4}$/.test(a)) {
      const [s, e] = a.split('-').map(Number);
      for (let y = s!; y <= e!; y++) years.push(y);
    }
  }

  if (years.length === 0) {
    const end = new Date().getFullYear() - 1;
    for (let y = end - 4; y <= end; y++) years.push(y);
  }
  years = [...new Set(years)].sort();
  return { years, tickers };
}

async function currentScore(ticker: string, price: number): Promise<{
  score: number | null;
  pvp: number | null;
}> {
  try {
    const proventos = (await dividendsProvider.fetchDividends(ticker)) ?? [];
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 12);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const recent = proventos.filter((e) => e.date >= cutoffStr);
    const sum12m = recent.reduce((s, e) => s + e.value, 0);
    const dy = price > 0 && sum12m > 0 ? +((sum12m / price) * 100).toFixed(2) : 0;

    let pvp: number | null = null;
    try {
      const cvm = await cvmFiiService.getLatestByTicker(ticker);
      if (cvm?.navPerShare && price > 0) {
        const nav = Number(cvm.navPerShare);
        if (nav > 0) pvp = +(price / nav).toFixed(3);
      }
    } catch { /* ok */ }

    const input: FIIScoreInput = {
      ticker,
      price,
      dy,
      pvp,
      liquidity: null,
      dividendsHistory: recent,
    };
    const s = FIIScoreCalculatorV4.calculate(input);
    return { score: s.overall_score, pvp };
  } catch {
    return { score: null, pvp: null };
  }
}

async function main() {
  const { years, tickers } = parseArgs();
  const runId = randomUUID();
  console.log('🧪 Urano FII Backtest — total return real\n');
  console.log(`🔖 run_id=${runId}`);
  console.log(`📅 anos=${years.join(', ')}`);
  console.log(`📋 tickers=${tickers.length}\n`);

  const yearRows: FiiYearRow[] = [];
  const dyPairsAll: Array<{
    ticker: string;
    year: number;
    trailingDyPct: number;
    nextTotalReturnPct: number;
  }> = [];
  const insertYears: Array<Record<string, unknown>> = [];
  const insertPairs: Array<Record<string, unknown>> = [];

  for (const ticker of tickers) {
    process.stdout.write(`  ${ticker}… `);
    try {
      const history = await stockQuoteService.getHistory(ticker, '5y');
      const prices = history.points.map((p) => ({ date: p.date, close: p.close }));
      const divs = (await dividendsProvider.fetchDividends(ticker)) ?? [];
      const cash = divs.map((d) => ({ date: d.date, value: d.value }));

      const annual = calendarYearTotalReturns(prices, cash, years);
      const lastPrice =
        prices.length > 0 ? prices[prices.length - 1]!.close : 0;
      const { score, pvp } = await currentScore(ticker, lastPrice);

      let okYears = 0;
      for (const y of years) {
        const tr = annual[y];
        if (!tr) continue;
        okYears++;
        yearRows.push({
          ticker,
          year: y,
          totalReturnPct: tr.totalReturnPct,
          priceReturnPct: tr.priceReturnPct,
          dividendReturnPct: tr.dividendReturnPct,
          score,
        });
        insertYears.push({
          runId,
          ticker,
          year: y,
          startPrice: String(tr.startPrice),
          endPrice: String(tr.endPrice),
          priceReturnPct: String(tr.priceReturnPct),
          dividendReturnPct: String(tr.dividendReturnPct),
          totalReturnPct: String(tr.totalReturnPct),
          dividendsSum: String(tr.dividendsSum),
          dividendEvents: tr.dividendEvents,
          score: score ?? null,
          pvp: pvp != null ? String(pvp) : null,
          priceSource: history.source,
          divSource: 'statusinvest_or_db',
        });
      }

      const pairs = trailingDyAndNextTotalReturn(prices, cash, years);
      for (const p of pairs) {
        dyPairsAll.push({
          ticker,
          year: p.year,
          trailingDyPct: p.trailingDyPct,
          nextTotalReturnPct: p.nextTotalReturnPct,
        });
        insertPairs.push({
          runId,
          ticker,
          year: p.year,
          nextYear: p.nextYear,
          trailingDyPct: String(p.trailingDyPct),
          nextTotalReturnPct: String(p.nextTotalReturnPct),
        });
      }

      console.log(`${okYears} anos, score=${score ?? 'n/d'}`);
      await new Promise((r) => setTimeout(r, 300));
    } catch (e) {
      console.log('fail:', e instanceof Error ? e.message : e);
    }
  }

  if (insertYears.length > 0) {
    // chunk insert
    for (let i = 0; i < insertYears.length; i += 100) {
      await db
        .insert(fiiBacktestYears)
        .values(insertYears.slice(i, i + 100) as never);
    }
  }
  if (insertPairs.length > 0) {
    for (let i = 0; i < insertPairs.length; i += 100) {
      await db
        .insert(fiiBacktestDyPairs)
        .values(insertPairs.slice(i, i + 100) as never);
    }
  }

  console.log('\n═══ TOTAL RETURN MÉDIO POR ANO (universo FII) ═══');
  for (const y of averageTotalReturnByYear(yearRows)) {
    console.log(
      `  ${y.year}: total ${y.avgTotal}% | preço ${y.avgPrice}% | proventos ${y.avgDiv}% | n=${y.n}`,
    );
  }

  console.log('\n═══ DY ANO Y → TOTAL RETURN Y+1 ═══');
  const pred = dyPredictsNextReturn(dyPairsAll);
  console.log(`  n=${pred.n} correlação=${pred.correlation}`);
  console.log(`  ${pred.interpretation}`);

  // Score atual (mesmo score em todos os anos — apenas ilustrativo, NÃO preditivo)
  console.log('\n═══ TOP 5 por score ATUAL vs universo (ilustrativo / bias) ═══');
  const top = topNByScoreVsUniverse(yearRows, 5);
  console.log(
    `  avg top5=${top.avgTop}% avg univ=${top.avgUniverse}% ganha ${top.winYears}/${top.years.length} anos`,
  );
  console.log(
    '  ⚠ score é o de hoje em todos os anos — não use como prova de edge; use a correlação DY.',
  );

  console.log(`\n💾 Gravado run_id=${runId} (${insertYears.length} linhas ano, ${insertPairs.length} pares DY)`);
  await closeDatabaseConnection().catch(() => {});
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
