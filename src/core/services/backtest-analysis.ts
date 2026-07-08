/**
 * BacktestAnalysis — estatística pura sobre resultados de backtest.
 * Sem I/O: recebe linhas, devolve correlações, buckets e simulação top N.
 */

export interface BacktestRow {
  year: number;
  ticker: string;
  score: number;
  valuation: number;
  profitability: number;
  growth: number;
  dividends: number;
  quality: number;
  momentum: number;
  return12m: number | null;
}

export const PILLARS = [
  'score', 'valuation', 'profitability', 'growth', 'dividends', 'quality', 'momentum',
] as const;
export type Pillar = (typeof PILLARS)[number];

export interface BucketStat {
  label: string;
  count: number;
  avgReturn: number;
  pctPositive: number;
  best: number;
  worst: number;
  bestTicker: string;
}

export interface StrategyYear { year: number; portfolioReturn: number; marketReturn: number; }

export interface StrategyResult {
  n: number;
  years: StrategyYear[];
  avgPortfolio: number;
  avgMarket: number;
  winYears: number;
  totalYears: number;
}

export function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

export function pearson(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  const ma = a.reduce((s, v) => s + v, 0) / a.length;
  const mb = b.reduce((s, v) => s + v, 0) / b.length;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < a.length; i++) {
    const da = (a[i] ?? 0) - ma;
    const db = (b[i] ?? 0) - mb;
    cov += da * db; va += da * da; vb += db * db;
  }
  return va > 0 && vb > 0 ? +(cov / Math.sqrt(va * vb)).toFixed(3) : 0;
}

/** Só considera linhas com retorno conhecido. */
function withReturn(rows: BacktestRow[]): BacktestRow[] {
  return rows.filter((r) => r.return12m !== null);
}

export function pillarCorrelations(rows: BacktestRow[]): Record<Pillar, number> {
  const wr = withReturn(rows);
  const returns = wr.map((r) => r.return12m as number);
  const out = {} as Record<Pillar, number>;
  for (const p of PILLARS) {
    out[p] = pearson(wr.map((r) => r[p]), returns);
  }
  return out;
}

export function scoreBuckets(rows: BacktestRow[], size = 10): BucketStat[] {
  const wr = withReturn(rows);
  const buckets: BucketStat[] = [];
  for (let lo = 0; lo < 100; lo += size) {
    const hi = lo + size;
    const items = wr.filter((r) => r.score >= lo && r.score < hi);
    if (items.length === 0) continue;
    const rets = items.map((r) => r.return12m as number);
    const best = [...items].sort(
      (a, b) => (b.return12m as number) - (a.return12m as number),
    )[0]!;
    buckets.push({
      label: `${lo}-${hi}`,
      count: items.length,
      avgReturn: +(rets.reduce((s, v) => s + v, 0) / rets.length).toFixed(2),
      pctPositive: +((rets.filter((v) => v > 0).length / rets.length) * 100).toFixed(1),
      best: Math.max(...rets),
      worst: Math.min(...rets),
      bestTicker: `${best.ticker} ${best.year}`,
    });
  }
  return buckets;
}

export function topNStrategy(rows: BacktestRow[], n: number): StrategyResult {
  const wr = withReturn(rows);
  const yearsList = [...new Set(wr.map((r) => r.year))].sort();
  const years: StrategyYear[] = [];
  for (const year of yearsList) {
    const yearRows = wr.filter((r) => r.year === year);
    if (yearRows.length === 0) continue;
    const top = [...yearRows].sort((a, b) => b.score - a.score).slice(0, n);
    const portfolioReturn =
      top.reduce((s, r) => s + (r.return12m as number), 0) / top.length;
    const marketReturn =
      yearRows.reduce((s, r) => s + (r.return12m as number), 0) / yearRows.length;
    years.push({
      year,
      portfolioReturn: +portfolioReturn.toFixed(2),
      marketReturn: +marketReturn.toFixed(2),
    });
  }
  const avg = (vals: number[]) =>
    vals.length > 0 ? +(vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(2) : 0;
  return {
    n,
    years,
    avgPortfolio: avg(years.map((y) => y.portfolioReturn)),
    avgMarket: avg(years.map((y) => y.marketReturn)),
    winYears: years.filter((y) => y.portfolioReturn > y.marketReturn).length,
    totalYears: years.length,
  };
}
