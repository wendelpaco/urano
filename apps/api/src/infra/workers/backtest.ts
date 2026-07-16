/**
 * Backtest Engine V2 — Diagnóstico completo + estratégias simuladas.
 *
 * Para cada ano:
 * 1. Calcula score com dados da época (look-ahead bias free)
 * 2. Verifica retorno 12 meses depois
 * 3. Simula estratégia: comprar top N por score
 * 4. Compara com IBOV e média do mercado
 *
 * Uso:
 *   bun run backtest              → detecta anos do banco
 *   bun run backtest 2015 2024    → range manual
 */

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { db } from '../database/connection.ts';
import { backtestResults, backtestStrategyYears } from '../database/schema.ts';
import { calcAllIndicators } from '../../core/services/indicators.ts';
import { StockScoreCalculator } from '../../core/services/stock-score.ts';
import type { HistoricalData } from '../../core/services/stock-score.ts';
import {
  PILLARS,
  percentile,
  pillarCorrelations,
  scoreBuckets,
  topNStrategy,
} from '../../core/services/backtest-analysis.ts';
import { sql } from 'drizzle-orm';

const SCORE_VERSION = 'v1';

interface BacktestResult {
  year: number;
  ticker: string;
  score: number;
  valuation: number;
  profitability: number;
  growth: number;
  dividends: number;
  quality: number;
  momentum: number;
  startPrice: number;
  endPrice: number | null;
  return12m: number | null;
}

async function getPriceAtDate(ticker: string, date: string): Promise<number | null> {
  try {
    const start = new Date(date);
    const end = new Date(start);
    end.setDate(end.getDate() + 5);
    const symbol = ticker.endsWith('.SA') ? ticker : `${ticker}.SA`;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&period1=${Math.floor(start.getTime() / 1000)}&period2=${Math.floor(end.getTime() / 1000)}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'error' });
    if (!r.ok) return null;
    const data = await r.json() as { chart: { result?: Array<{ indicators: { quote: Array<{ close: number[] }> } }> } };
    const closes = data.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
    if (!closes) return null;
    for (const c of closes) { if (c && c > 0) return c; }
    return null;
  } catch { return null; }
}

function toNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function buildHistorical(yearRows: Record<string, unknown>[]): HistoricalData | undefined {
  const years = yearRows.map((r) => {
    const revenue = toNum(r.revenue);
    const netIncome = toNum(r.net_income_parent);
    const equity = toNum(r.equity);
    const liabilities = toNum(r.total_liabilities);
    const cogs = Math.abs(toNum(r.cogs));
    return {
      fiscalYear: Number(r.fiscal_year),
      revenue,
      netIncome,
      roe: equity > 0 ? (netIncome / equity) * 100 : 0,
      netMargin: revenue > 0 ? (netIncome / revenue) * 100 : 0,
      debtToEquity: equity > 0 ? liabilities / equity : 0,
      grossMargin: revenue > 0 ? ((revenue - cogs) / revenue) * 100 : 0,
    };
  });
  return years.length >= 2 ? { years } : undefined;
}

async function backtestYear(year: number): Promise<BacktestResult[]> {
  console.log(`\n📅 Backtesting ${year}...`);

  const rows = await db.execute(sql`
    SELECT DISTINCT ON (c.ticker, cf.fiscal_year)
      c.ticker, c.name, c.sector,
      cf.revenue, cf.cogs, cf.ebit, cf.net_income_parent,
      cf.total_assets, cf.total_liabilities, cf.cash,
      cf.operating_cash_flow, cf.equity, cf.shares_outstanding,
      cf.reference_date, cf.fiscal_year
     FROM company_fundamentals cf
     JOIN companies c ON c.cnpj = cf.company_cnpj
     WHERE cf.fiscal_year BETWEEN ${year - 4} AND ${year}
       AND (c.ticker NOT LIKE '%11' OR c.ticker IN ('KLBN11','SANB11','TAEE11','ENGI11','ALUP11','BPAC11'))
     ORDER BY c.ticker, cf.fiscal_year, cf.reference_date DESC
  `);

  // Agrupa linhas por ticker (cada linha = um ano fiscal)
  const byTicker = new Map<string, Record<string, unknown>[]>();
  for (const r of rows as unknown as Record<string, unknown>[]) {
    const t = String(r.ticker);
    if (!byTicker.has(t)) byTicker.set(t, []);
    byTicker.get(t)!.push(r);
  }

  const results: BacktestResult[] = [];
  let count = 0;

  for (const [ticker, tickerRows] of byTicker) {
    // Linha do ano do backtest = a mais recente daquele fiscal_year
    const current = tickerRows.find((r) => Number(r.fiscal_year) === year);
    if (!current) continue;

    // ENG-5r: demonstrações são publicadas ~4 meses após a data de referência.
    // Entramos na data de filing real (reference_date + 4 meses) para evitar
    // look-ahead bias — o mercado só conhece os fundamentos após divulgação.
    const refDate = String(current.reference_date || `${year}-12-31`);
    const entryDate = new Date(refDate);
    entryDate.setMonth(entryDate.getMonth() + 4);
    const entryDateStr = entryDate.toISOString().slice(0, 10);

    const startPrice = await getPriceAtDate(ticker, entryDateStr);
    if (!startPrice || startPrice <= 0) continue;

    // Retorno 12 meses a partir da data de entrada (não da data do balanço)
    const endDate = new Date(entryDateStr);
    endDate.setFullYear(endDate.getFullYear() + 1);
    const endPrice = await getPriceAtDate(ticker, endDate.toISOString().slice(0, 10));

    const indicators = calcAllIndicators(current, startPrice);
    // DY real via DMPL CVM (já em calcAllIndicators); reforço se campos snake_case
    if (indicators.dividendYield == null) {
      const div = Number(current.dividends_paid ?? 0) + Number(current.jcp_paid ?? 0);
      const sh = Number(current.shares_outstanding ?? 0);
      if (div > 0 && sh > 0 && startPrice > 0) {
        indicators.dividendYield = +((div / (sh * startPrice)) * 100).toFixed(2);
      }
    }

    // Momentum real look-ahead-free: retornos 3M/6M até a data de ENTRADA
    // (não até a data do balanço — ENG-5r)
    let momentum: import('../services/market-data-service.ts').MarketMomentum | undefined;
    try {
      const d0 = new Date(entryDateStr);
      const d3 = new Date(d0); d3.setMonth(d3.getMonth() - 3);
      const d6 = new Date(d0); d6.setMonth(d6.getMonth() - 6);
      const p3 = await getPriceAtDate(ticker, d3.toISOString().slice(0, 10));
      const p6 = await getPriceAtDate(ticker, d6.toISOString().slice(0, 10));
      const return3m =
        p3 && p3 > 0 ? +(((startPrice - p3) / p3) * 100).toFixed(1) : null;
      const return6m =
        p6 && p6 > 0 ? +(((startPrice - p6) / p6) * 100).toFixed(1) : null;
      if (return3m != null || return6m != null) {
        momentum = {
          ticker,
          price: startPrice,
          return3m,
          return6m,
          drawdownFrom52WeekHigh: null,
          annualizedVolatility: null,
          avgVolume: null,
        };
      }
    } catch { /* ok */ }

    const historical = buildHistorical(tickerRows);
    const scoreResult = StockScoreCalculator.calculate(
      indicators,
      (current.sector as string) || null,
      String(current.name),
      historical,
      momentum,
    );

    results.push({
      year, ticker,
      score: scoreResult.score,
      valuation: scoreResult.breakdown.valuation.score,
      profitability: scoreResult.breakdown.profitability.score,
      growth: scoreResult.breakdown.growth.score,
      dividends: scoreResult.breakdown.dividends.score,
      quality: scoreResult.breakdown.quality.score,
      momentum: scoreResult.breakdown.momentum.score,
      startPrice: Math.round(startPrice * 100) / 100,
      endPrice: endPrice ? Math.round(endPrice * 100) / 100 : null,
      return12m: endPrice ? Math.round(((endPrice - startPrice) / startPrice) * 10000) / 100 : null,
    });

    count++;
    if (count % 10 === 0) process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(` ${results.length} ativos`);
  return results;
}

// ─── Análise ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('🧪 Urano Backtest Engine V2\n');
  console.log('Comparando scores vs retorno real 12 meses depois\n');

  const args = process.argv.slice(2);
  let years: number[];

  if (args.length >= 2) {
    const start = parseInt(args[0]!, 10), end = parseInt(args[1]!, 10);
    years = [];
    for (let y = start; y <= end; y++) years.push(y);
    console.log(`📅 Anos: ${start}-${end} (via argumentos)`);
  } else {
    const yearRows = await db.execute('SELECT DISTINCT fiscal_year FROM company_fundamentals ORDER BY fiscal_year');
    years = (yearRows as unknown as Array<{ fiscal_year: number }>)
      .map(r => r.fiscal_year)
      .filter(y => y >= 2015 && y <= new Date().getFullYear() - 1);
    console.log(`📅 Anos detectados: ${years.join(', ')} (${years.length} anos)`);
  }

  if (years.length === 0) {
    console.log('❌ Nenhum ano disponível.');
    process.exit(1);
  }

  const runId = randomUUID();
  console.log(`🔖 Run ID: ${runId} (score ${SCORE_VERSION})\n`);

  const allResults: BacktestResult[] = [];
  for (const year of years) {
    const results = await backtestYear(year);
    allResults.push(...results);

    if (results.length > 0) {
      await db.insert(backtestResults).values(
        results.map((r) => ({
          runId,
          scoreVersion: SCORE_VERSION,
          year: r.year,
          ticker: r.ticker,
          score: r.score,
          valuation: r.valuation,
          profitability: r.profitability,
          growth: r.growth,
          dividends: r.dividends,
          quality: r.quality,
          momentum: r.momentum,
          startPrice: String(r.startPrice),
          endPrice: r.endPrice === null ? null : String(r.endPrice),
          return12m: r.return12m === null ? null : String(r.return12m),
        })),
      );
    }
  }

  const wr = allResults.filter(r => r.return12m !== null);

  // ═══ SCORE DISTRIBUTION ═══
  const scores = wr.map(r => r.score);
  console.log('\n═══ DISTRIBUIÇÃO DOS SCORES ═══');
  console.log(`Mín: ${Math.min(...scores)}  P25: ${percentile(scores, 25)}  Mediana: ${percentile(scores, 50)}  P75: ${percentile(scores, 75)}  Máx: ${Math.max(...scores)}`);

  // ═══ CORRELAÇÃO POR PILAR ═══
  console.log('\n═══ CORRELAÇÃO SCORE vs RETORNO 12M ═══');
  const corrs = pillarCorrelations(allResults);
  for (const p of PILLARS) {
    console.log(`  ${p.padEnd(15)}: ${corrs[p]}`);
  }

  // ═══ BUCKETS ═══
  console.log('\n═══ RESULTADOS POR FAIXA DE SCORE ═══');
  console.log('Faixa      | Casos | Retorno Méd | % Pos | Melhor  | Pior    | Top Ticker');
  console.log('───────────|───────|─────────────|──────|─────────|─────────|───────────');
  for (const b of scoreBuckets(allResults)) {
    console.log(`${b.label.padEnd(10)} | ${String(b.count).padStart(5)} | ${String(b.avgReturn.toFixed(1) + '%').padStart(11)} | ${String(b.pctPositive.toFixed(0) + '%').padStart(4)} | ${String(b.best.toFixed(1) + '%').padStart(7)} | ${String(b.worst.toFixed(1) + '%').padStart(7)} | ${b.bestTicker}`);
  }

  // ═══ ESTRATÉGIA: TOP N POR SCORE ═══
  console.log('\n═══ SIMULAÇÃO DE ESTRATÉGIA ═══');
  console.log('Compra top N por score a cada ano, vende 12 meses depois\n');

  // IBOV real (Yahoo ^BVSP) — retornos civis para os mesmos anos do backtest
  let ibovByYear: Record<number, number | null> | undefined;
  try {
    const { fetchIbovCalendarReturns } = await import('../services/ibov-benchmark.ts');
    const years = [...new Set(allResults.map((r) => r.year))];
    const ibov = await fetchIbovCalendarReturns(years);
    ibovByYear = ibov.byYear;
    console.log(`  IBOV fonte: ${ibov.source} ${ibov.symbol} asOf=${ibov.asOf}`);
    for (const y of years.sort()) {
      const v = ibov.byYear[y];
      console.log(`    ${y}: ${v == null ? 'n/d' : v.toFixed(1) + '%'}`);
    }
  } catch (e) {
    console.warn('  IBOV Yahoo indisponível:', e instanceof Error ? e.message : e);
  }

  const strategyRows: Array<{
    runId: string;
    scoreVersion: string;
    n: number;
    year: number;
    portfolioReturn: string;
    universeReturn: string;
    ibovReturn: string | null;
    ibovSource: string | null;
  }> = [];

  for (const n of [3, 5, 10]) {
    const s = topNStrategy(allResults, n, ibovByYear);
    const vsMkt = (s.avgPortfolio - s.avgMarket).toFixed(1);
    const vsIbov =
      s.avgIbov != null ? (s.avgPortfolio - s.avgIbov).toFixed(1) : 'n/d';
    console.log(
      `  Top ${String(n).padStart(2)}: Retorno médio ${s.avgPortfolio.toFixed(1)}%  |  vs Universo ${vsMkt}pp  |  vs IBOV ${vsIbov}pp  |  ganha univ. ${s.winYears}/${s.totalYears}` +
        (s.winYearsVsIbov != null ? `  |  ganha IBOV ${s.winYearsVsIbov}/${s.ibovYears}` : ''),
    );

    for (const y of s.years) {
      strategyRows.push({
        runId,
        scoreVersion: SCORE_VERSION,
        n,
        year: y.year,
        portfolioReturn: String(y.portfolioReturn),
        universeReturn: String(y.marketReturn),
        ibovReturn:
          typeof y.ibovReturn === 'number' ? String(y.ibovReturn) : null,
        ibovSource: typeof y.ibovReturn === 'number' ? 'yahoo_^BVSP' : null,
      });
    }
  }

  if (strategyRows.length > 0) {
    await db.insert(backtestStrategyYears).values(strategyRows);
    console.log(`\n💾 Estratégias gravadas em backtest_strategy_years (${strategyRows.length} linhas)`);
  }

  // ═══ DIAGNÓSTICO DO MODELO ═══
  console.log('\n═══ DIAGNÓSTICO ═══');
  const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
  const highScore = wr.filter(r => r.score >= 60);
  const lowScore = wr.filter(r => r.score < 40);
  console.log(`  Score médio: ${avgScore.toFixed(1)}`);
  console.log(`  Scores >= 60: ${highScore.length} (${((highScore.length / wr.length) * 100).toFixed(1)}%)`);
  console.log(`  Scores < 40: ${lowScore.length} (${((lowScore.length / wr.length) * 100).toFixed(1)}%)`);

  for (const p of ['valuation', 'profitability', 'growth', 'dividends', 'quality', 'momentum']) {
    const vals = wr.map(r => (r as unknown as Record<string, number>)[p] ?? 0);
    console.log(`  ${p.padEnd(15)}: média ${(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1)}  min ${Math.min(...vals)}  max ${Math.max(...vals)}`);
  }

  console.log(`\n💾 Resultados gravados em backtest_results (run_id: ${runId})`);

  process.exit(0);
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
