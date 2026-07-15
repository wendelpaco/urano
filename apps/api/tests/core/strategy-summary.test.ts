import { describe, expect, test } from 'bun:test';
import { summarizeStrategyYears } from '../../src/infra/database/backtest-queries.ts';
import type { StrategyYearRow } from '../../src/infra/database/backtest-queries.ts';

describe('summarizeStrategyYears', () => {
  test('agrega portfolio, universo e IBOV reais', () => {
    const years: StrategyYearRow[] = [
      {
        runId: 'r1',
        scoreVersion: 'v1',
        n: 10,
        year: 2020,
        portfolioReturn: 30,
        universeReturn: 10,
        ibovReturn: 5,
        ibovSource: 'yahoo_^BVSP',
      },
      {
        runId: 'r1',
        scoreVersion: 'v1',
        n: 10,
        year: 2021,
        portfolioReturn: -5,
        universeReturn: -8,
        ibovReturn: -12,
        ibovSource: 'yahoo_^BVSP',
      },
    ];
    const s = summarizeStrategyYears(years);
    expect(s.avgPortfolio).toBe(12.5);
    expect(s.avgUniverse).toBe(1);
    expect(s.avgIbov).toBe(-3.5);
    expect(s.winYearsVsUniverse).toBe(2);
    expect(s.winYearsVsIbov).toBe(2);
    expect(s.totalYears).toBe(2);
    expect(s.byYear).toHaveLength(2);
  });
});
