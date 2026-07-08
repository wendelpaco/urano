/**
 * Backtest Engine — Valida se o modelo de score tem poder preditivo.
 *
 * Para cada ano de 2018 a 2023:
 * 1. Calcula o score usando APENAS dados disponíveis naquele ano
 * 2. Verifica o retorno da ação nos 12 meses seguintes (via preço Yahoo)
 * 3. Compara: ações com score > 60 vs score < 40 vs IBOV
 */

import 'dotenv/config';
import { db } from '../database/connection.ts';
import { companies, companyFundamentals } from '../database/schema.ts';
import { stockQuoteService } from '../services/stock-quote-service.ts';
import { calcAllIndicators } from '../../core/services/indicators.ts';
import { StockScoreCalculator } from '../../core/services/stock-score.ts';
import { eq, and, desc } from 'drizzle-orm';

interface BacktestResult {
  year: number;
  ticker: string;
  score: number;
  startPrice: number;
  endPrice: number | null;
  return12m: number | null;
}

async function getPriceAtDate(ticker: string, date: string): Promise<number | null> {
  try {
    // Yahoo history tem dados desde ~2017
    const start = new Date(date);
    const end = new Date(start);
    end.setDate(end.getDate() + 5); // janela de 5 dias

    const startStr = Math.floor(start.getTime() / 1000);
    const endStr = Math.floor(end.getTime() / 1000);

    const symbol = ticker.endsWith('.SA') ? ticker : `${ticker}.SA`;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&period1=${startStr}&period2=${endStr}`;

    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;

    const data = await r.json() as {
      chart: { result?: Array<{ indicators: { quote: Array<{ close: number[] }> } }> };
    };

    const closes = data.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
    if (!closes || closes.length === 0) return null;

    // Pega o primeiro preço disponível
    for (const c of closes) {
      if (c && c > 0) return c;
    }
    return null;
  } catch {
    return null;
  }
}

async function backtestYear(year: number): Promise<BacktestResult[]> {
  console.log(`\n📅 Backtesting ${year}...`);

  // Busca fundamentals do ano
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

    // Preço no fim do ano fiscal (~março do ano seguinte)
    const refDate = String(r.reference_date || `${year}-12-31`);
    const startPrice = await getPriceAtDate(ticker, refDate);
    if (!startPrice || startPrice <= 0) continue;

    // Preço 12 meses depois
    const endDate = new Date(refDate);
    endDate.setFullYear(endDate.getFullYear() + 1);
    const endPrice = await getPriceAtDate(ticker, endDate.toISOString().slice(0, 10));

    // Calcula score com dados da época
    const indicators = calcAllIndicators(r, startPrice);
    const scoreResult = StockScoreCalculator.calculate(
      indicators,
      (r.sector as string) || null,
      String(r.name),
    );

    results.push({
      year,
      ticker,
      score: scoreResult.score,
      startPrice: Math.round(startPrice * 100) / 100,
      endPrice: endPrice ? Math.round(endPrice * 100) / 100 : null,
      return12m: endPrice ? Math.round(((endPrice - startPrice) / startPrice) * 10000) / 100 : null,
    });

    count++;
    if (count % 5 === 0) process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 200)); // rate limit Yahoo
  }

  return results;
}

async function main(): Promise<void> {
  console.log('🧪 Urano Backtest Engine\n');
  console.log('Comparando scores vs retorno real 12 meses depois\n');

  // Detecta anos disponíveis do banco ou usa argumentos da CLI
  const args = process.argv.slice(2);
  let years: number[];

  if (args.length >= 2) {
    // bun run backtest 2015 2024
    const start = parseInt(args[0]!, 10);
    const end = parseInt(args[1]!, 10);
    years = [];
    for (let y = start; y <= end; y++) years.push(y);
    console.log(`📅 Anos: ${start}-${end} (via argumentos)`);
  } else {
    // Detecta do banco
    const yearRows = await db.execute(
      'SELECT DISTINCT fiscal_year FROM company_fundamentals ORDER BY fiscal_year',
    );
    years = (yearRows as unknown as Array<{ fiscal_year: number }>)
      .map((r) => r.fiscal_year)
      .filter((y) => y >= 2015 && y <= new Date().getFullYear() - 1); // até ano anterior
    console.log(`📅 Anos detectados: ${years.join(', ')} (${years.length} anos)`);
  }

  if (years.length === 0) {
    console.log('❌ Nenhum ano disponível. Execute worker:sync primeiro.');
    process.exit(1);
  }

  const allResults: BacktestResult[] = [];

  for (const year of years) {
    const results = await backtestYear(year);
    allResults.push(...results);
    console.log(` ${results.length} ativos analisados`);
  }

  // ── Análise ──────────────────────────────────────────────────────────
  const withReturns = allResults.filter((r) => r.return12m !== null);
  console.log(`\n📊 Total: ${allResults.length} análises, ${withReturns.length} com retorno\n`);

  // Agrupa por faixa de score
  const buckets = {
    'Score 70+': withReturns.filter((r) => r.score >= 70),
    'Score 55-69': withReturns.filter((r) => r.score >= 55 && r.score < 70),
    'Score 40-54': withReturns.filter((r) => r.score >= 40 && r.score < 55),
    'Score <40': withReturns.filter((r) => r.score < 40),
  };

  console.log('═══ RESULTADOS DO BACKTEST ═══');
  console.log('Faixa de Score     | Casos | Retorno Médio | % Positivos | Melhor | Pior');
  console.log('────────────────────|───────|───────────────|─────────────|────────|─────');

  for (const [label, items] of Object.entries(buckets)) {
    if (items.length === 0) continue;
    const avgReturn = items.reduce((s, r) => s + (r.return12m ?? 0), 0) / items.length;
    const pctPositive = (items.filter((r) => (r.return12m ?? 0) > 0).length / items.length) * 100;
    const best = Math.max(...items.map((r) => r.return12m ?? 0));
    const worst = Math.min(...items.map((r) => r.return12m ?? 0));
    console.log(
      `${label.padEnd(18)} | ${String(items.length).padStart(5)} | ${String(avgReturn.toFixed(1) + '%').padStart(13)} | ${String(pctPositive.toFixed(1) + '%').padStart(11)} | ${String(best.toFixed(1) + '%').padStart(6)} | ${String(worst.toFixed(1) + '%').padStart(4)}`,
    );
  }

  // ── Correlação ───────────────────────────────────────────────────────
  const scores = withReturns.map((r) => r.score);
  const returns = withReturns.map((r) => r.return12m ?? 0);
  const meanScore = scores.reduce((a, b) => a + b, 0) / scores.length;
  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;

  let cov = 0, varScore = 0, varReturn = 0;
  for (let i = 0; i < scores.length; i++) {
    const ds = scores[i]! - meanScore;
    const dr = returns[i]! - meanReturn;
    cov += ds * dr;
    varScore += ds * ds;
    varReturn += dr * dr;
  }
  const correlation = cov / Math.sqrt(varScore * varReturn);

  console.log(`\n📈 Correlação Score vs Retorno 12M: ${correlation.toFixed(3)}`);
  console.log(correlation > 0.15
    ? '   ✅ O modelo tem poder preditivo positivo!'
    : correlation > 0
      ? '   ⚠️  Correlação fraca mas positiva.'
      : '   ❌ Modelo não tem poder preditivo.');

  process.exit(0);
}

main().catch((err) => { console.error('❌', err.message); process.exit(1); });
