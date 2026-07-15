/**
 * Estatística pura sobre backtest de FII (total return).
 */

import { pearson } from './backtest-analysis.ts';

export interface FiiYearRow {
  ticker: string;
  year: number;
  totalReturnPct: number;
  priceReturnPct: number;
  dividendReturnPct: number;
  score?: number | null;
}

export interface FiiDyPair {
  ticker: string;
  year: number;
  trailingDyPct: number;
  nextTotalReturnPct: number;
}

export function averageTotalReturnByYear(
  rows: FiiYearRow[],
): Array<{ year: number; avgTotal: number; avgPrice: number; avgDiv: number; n: number }> {
  const byYear = new Map<number, FiiYearRow[]>();
  for (const r of rows) {
    if (!byYear.has(r.year)) byYear.set(r.year, []);
    byYear.get(r.year)!.push(r);
  }
  return [...byYear.entries()]
    .sort(([a], [b]) => a - b)
    .map(([year, list]) => {
      const avg = (xs: number[]) =>
        xs.length ? +(xs.reduce((s, v) => s + v, 0) / xs.length).toFixed(2) : 0;
      return {
        year,
        avgTotal: avg(list.map((r) => r.totalReturnPct)),
        avgPrice: avg(list.map((r) => r.priceReturnPct)),
        avgDiv: avg(list.map((r) => r.dividendReturnPct)),
        n: list.length,
      };
    });
}

/** Correlação DY trailing (ano Y) → total return (ano Y+1). */
export function dyPredictsNextReturn(pairs: FiiDyPair[]): {
  n: number;
  correlation: number;
  interpretation: string;
} {
  if (pairs.length < 5) {
    return {
      n: pairs.length,
      correlation: 0,
      interpretation: 'Amostra pequena demais para correlação confiável.',
    };
  }
  const corr = pearson(
    pairs.map((p) => p.trailingDyPct),
    pairs.map((p) => p.nextTotalReturnPct),
  );
  let interpretation = 'Sem relação clara entre DY passado e total return futuro.';
  if (corr >= 0.3) {
    interpretation =
      'DY mais alto no ano anterior tende a associar-se a melhor total return no ano seguinte (sinal fraco/moderado).';
  } else if (corr <= -0.3) {
    interpretation =
      'DY alto no ano anterior associa-se a pior total return no seguinte (possível mean-reversion / yield trap).';
  }
  return { n: pairs.length, correlation: corr, interpretation };
}

/** Top N por score (quando score presente) vs média do universo no mesmo ano. */
export function topNByScoreVsUniverse(
  rows: FiiYearRow[],
  n: number,
): {
  n: number;
  years: Array<{ year: number; topAvg: number; universeAvg: number }>;
  avgTop: number;
  avgUniverse: number;
  winYears: number;
} {
  const withScore = rows.filter((r) => r.score != null);
  const yearsList = [...new Set(withScore.map((r) => r.year))].sort();
  const years: Array<{ year: number; topAvg: number; universeAvg: number }> = [];

  for (const year of yearsList) {
    const yr = withScore.filter((r) => r.year === year);
    if (yr.length < n) continue;
    const top = [...yr].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, n);
    const topAvg =
      top.reduce((s, r) => s + r.totalReturnPct, 0) / top.length;
    const universeAvg =
      yr.reduce((s, r) => s + r.totalReturnPct, 0) / yr.length;
    years.push({
      year,
      topAvg: +topAvg.toFixed(2),
      universeAvg: +universeAvg.toFixed(2),
    });
  }

  const avg = (xs: number[]) =>
    xs.length ? +(xs.reduce((s, v) => s + v, 0) / xs.length).toFixed(2) : 0;

  return {
    n,
    years,
    avgTop: avg(years.map((y) => y.topAvg)),
    avgUniverse: avg(years.map((y) => y.universeAvg)),
    winYears: years.filter((y) => y.topAvg > y.universeAvg).length,
  };
}
