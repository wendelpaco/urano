/**
 * Leitura do último backtest FII (total return).
 */

import { desc, eq } from 'drizzle-orm';
import { db } from './connection.ts';
import { fiiBacktestDyPairs, fiiBacktestYears } from './schema.ts';
import {
  averageTotalReturnByYear,
  dyPredictsNextReturn,
  type FiiDyPair,
  type FiiYearRow,
} from '../../core/services/fii-backtest-analysis.ts';

export async function getLatestFiiBacktestSummary() {
  const [latest] = await db
    .select({
      runId: fiiBacktestYears.runId,
      createdAt: fiiBacktestYears.createdAt,
    })
    .from(fiiBacktestYears)
    .orderBy(desc(fiiBacktestYears.createdAt))
    .limit(1);

  if (!latest) return null;

  const years = await db
    .select()
    .from(fiiBacktestYears)
    .where(eq(fiiBacktestYears.runId, latest.runId));

  const pairs = await db
    .select()
    .from(fiiBacktestDyPairs)
    .where(eq(fiiBacktestDyPairs.runId, latest.runId));

  const yearRows: FiiYearRow[] = years
    .filter((y) => y.totalReturnPct != null)
    .map((y) => ({
      ticker: y.ticker,
      year: y.year,
      totalReturnPct: Number(y.totalReturnPct),
      priceReturnPct: Number(y.priceReturnPct ?? 0),
      dividendReturnPct: Number(y.dividendReturnPct ?? 0),
      score: y.score,
    }));

  const dyPairs: FiiDyPair[] = pairs.map((p) => ({
    ticker: p.ticker,
    year: p.year,
    trailingDyPct: Number(p.trailingDyPct),
    nextTotalReturnPct: Number(p.nextTotalReturnPct),
  }));

  return {
    runId: latest.runId,
    createdAt: latest.createdAt,
    observations: yearRows.length,
    tickers: [...new Set(yearRows.map((r) => r.ticker))].length,
    byYear: averageTotalReturnByYear(yearRows),
    dyPredictsNext: dyPredictsNextReturn(dyPairs),
    dataQuality: {
      freeSourcesOnly: true,
      priceSource: 'yahoo',
      dividendSource: 'statusinvest_or_db',
      scoreNote:
        'Score gravado é o atual (não histórico). Correlação DY→TR seguinte é look-ahead free.',
    },
  };
}
