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
  const incomeDefinitionValid =
    years.length > 0 &&
    years.every((year) => year.divSource === 'statusinvest_db_income_v2');
  const dyPredictsNext = incomeDefinitionValid
    ? (() => {
        const result = dyPredictsNextReturn(dyPairs);
        return {
          ...result,
          interpretation:
            `${result.interpretation} Resultado exploratório: o universo atual introduz viés de sobrevivência/seleção.`,
        };
      })()
    : {
        n: 0,
        correlation: 0,
        interpretation:
          'Run legado: a correlação DY→retorno foi ocultada porque amortizações ainda podiam compor o DY. Reexecute o backtest com a metodologia income-v2.',
      };

  return {
    runId: latest.runId,
    createdAt: latest.createdAt,
    observations: yearRows.length,
    tickers: [...new Set(yearRows.map((r) => r.ticker))].length,
    byYear: averageTotalReturnByYear(yearRows),
    dyPredictsNext,
    dataQuality: {
      freeSourcesOnly: true,
      priceSource: 'yahoo',
      dividendSource: 'statusinvest_or_db',
      dyMethodology: incomeDefinitionValid ? 'income-v2' : 'legacy-invalid',
      incomeDefinitionValid,
      pointInTimeUniverse: false,
      validationStatus: 'exploratory_survivorship_bias',
      scoreNote:
        incomeDefinitionValid
          ? 'Score gravado é o atual (não histórico). DY separa renda de amortização, mas a lista atual exclui fundos encerrados e não constitui universo ponto-no-tempo.'
          : 'Score gravado é o atual (não histórico). A estatística DY do run legado foi invalidada e exige reexecução.',
    },
  };
}
