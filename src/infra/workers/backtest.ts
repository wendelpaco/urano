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
import { backtestResults, companies, companyFundamentals } from '../database/schema.ts';
import { stockQuoteService } from '../services/stock-quote-service.ts';
import { calcAllIndicators } from '../../core/services/indicators.ts';
import { StockScoreCalculator } from '../../core/services/stock-score.ts';
import {
  PILLARS,
  percentile,
  pillarCorrelations,
  scoreBuckets,
  topNStrategy,
} from '../../core/services/backtest-analysis.ts';
import { eq, desc } from 'drizzle-orm';

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
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    const data = await r.json() as { chart: { result?: Array<{ indicators: { quote: Array<{ close: number[] }> } }> } };
    const closes = data.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
    if (!closes) return null;
    for (const c of closes) { if (c && c > 0) return c; }
    return null;
  } catch { return null; }
}

async function backtestYear(year: number): Promise<BacktestResult[]> {
  console.log(`\n📅 Backtesting ${year}...`);

  const rows = await db.execute(
    `SELECT DISTINCT ON (c.ticker)
      c.ticker, c.name, c.sector,
      cf.revenue, cf.cogs, cf.ebit, cf.net_income_parent,
      cf.total_assets, cf.total_liabilities, cf.cash,
      cf.operating_cash_flow, cf.equity, cf.shares_outstanding,
      cf.reference_date, cf.fiscal_year
     FROM company_fundamentals cf
     JOIN companies c ON c.cnpj = cf.company_cnpj
     WHERE cf.fiscal_year = ${year}
       AND c.ticker NOT LIKE '%11'
     ORDER BY c.ticker, cf.reference_date DESC`,
  );

  const results: BacktestResult[] = [];
  let count = 0;

  for (const r of rows as unknown as Record<string, unknown>[]) {
    const ticker = String(r.ticker);
    const refDate = String(r.reference_date || `${year}-12-31`);

    const startPrice = await getPriceAtDate(ticker, refDate);
    if (!startPrice || startPrice <= 0) continue;

    const endDate = new Date(refDate);
    endDate.setFullYear(endDate.getFullYear() + 1);
    const endPrice = await getPriceAtDate(ticker, endDate.toISOString().slice(0, 10));

    const indicators = calcAllIndicators(r, startPrice);
    const scoreResult = StockScoreCalculator.calculate(indicators, (r.sector as string) || null, String(r.name));

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
  for (const n of [3, 5, 10]) {
    const s = topNStrategy(allResults, n);
    console.log(`  Top ${String(n).padStart(2)}: Retorno médio ${s.avgPortfolio.toFixed(1)}%  |  vs Mercado ${(s.avgPortfolio - s.avgMarket).toFixed(1)}pp  |  ganha em ${s.winYears}/${s.totalYears} anos`);
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
