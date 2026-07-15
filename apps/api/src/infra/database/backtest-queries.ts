/**
 * Leitura de resultados de backtest persistidos (estratégia ano a ano + IBOV).
 */

import { desc, eq, sql } from 'drizzle-orm';
import { db } from './connection.ts';
import { backtestResults, backtestStrategyYears } from './schema.ts';

export interface StrategyYearRow {
  runId: string;
  scoreVersion: string;
  n: number;
  year: number;
  portfolioReturn: number;
  universeReturn: number;
  ibovReturn: number | null;
  ibovSource: string | null;
}

/** Último run_id gravado em backtest_results. */
export async function getLatestBacktestRunId(): Promise<string | null> {
  const [row] = await db
    .select({
      runId: backtestResults.runId,
      createdAt: backtestResults.createdAt,
    })
    .from(backtestResults)
    .orderBy(desc(backtestResults.createdAt))
    .limit(1);
  return row?.runId ?? null;
}

export async function getStrategyYearsForRun(
  runId: string,
  n = 10,
): Promise<StrategyYearRow[]> {
  const rows = await db
    .select()
    .from(backtestStrategyYears)
    .where(
      sql`${backtestStrategyYears.runId} = ${runId} AND ${backtestStrategyYears.n} = ${n}`,
    )
    .orderBy(backtestStrategyYears.year);

  return rows.map((r) => ({
    runId: r.runId,
    scoreVersion: r.scoreVersion,
    n: r.n,
    year: r.year,
    portfolioReturn: Number(r.portfolioReturn),
    universeReturn: Number(r.universeReturn),
    ibovReturn: r.ibovReturn == null ? null : Number(r.ibovReturn),
    ibovSource: r.ibovSource,
  }));
}

export async function getLatestStrategyYears(n = 10): Promise<{
  runId: string;
  scoreVersion: string;
  years: StrategyYearRow[];
} | null> {
  // Prefer runs that already have strategy years
  const [latest] = await db
    .select({
      runId: backtestStrategyYears.runId,
      scoreVersion: backtestStrategyYears.scoreVersion,
      createdAt: backtestStrategyYears.createdAt,
    })
    .from(backtestStrategyYears)
    .where(eq(backtestStrategyYears.n, n))
    .orderBy(desc(backtestStrategyYears.createdAt))
    .limit(1);

  if (!latest) return null;

  const years = await getStrategyYearsForRun(latest.runId, n);
  if (years.length === 0) return null;

  return {
    runId: latest.runId,
    scoreVersion: latest.scoreVersion,
    years,
  };
}

export function summarizeStrategyYears(years: StrategyYearRow[]) {
  const avg = (vals: number[]) =>
    vals.length > 0
      ? +(vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(2)
      : null;

  const portfolio = years.map((y) => y.portfolioReturn);
  const universe = years.map((y) => y.universeReturn);
  const ibov = years
    .map((y) => y.ibovReturn)
    .filter((v): v is number => typeof v === 'number');

  return {
    avgPortfolio: avg(portfolio),
    avgUniverse: avg(universe),
    avgIbov: avg(ibov),
    winYearsVsUniverse: years.filter((y) => y.portfolioReturn > y.universeReturn)
      .length,
    winYearsVsIbov: years.filter(
      (y) => typeof y.ibovReturn === 'number' && y.portfolioReturn > y.ibovReturn!,
    ).length,
    totalYears: years.length,
    ibovYears: ibov.length,
    byYear: years.map((y) => ({
      year: y.year,
      portfolioReturn: y.portfolioReturn,
      universeReturn: y.universeReturn,
      ibovReturn: y.ibovReturn,
    })),
  };
}
