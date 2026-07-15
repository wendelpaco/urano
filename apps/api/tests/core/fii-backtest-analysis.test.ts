import { describe, expect, test } from 'bun:test';
import {
  averageTotalReturnByYear,
  dyPredictsNextReturn,
  topNByScoreVsUniverse,
} from '../../src/core/services/fii-backtest-analysis.ts';
import {
  calendarYearTotalReturns,
  trailingDyAndNextTotalReturn,
} from '../../src/core/services/total-return.ts';

describe('calendarYearTotalReturns', () => {
  test('calcula TR por ano civil com proventos', () => {
    const prices = [
      { date: '2020-01-02', close: 100 },
      { date: '2020-12-30', close: 100 },
      { date: '2021-01-04', close: 110 },
      { date: '2022-01-03', close: 110 },
    ];
    const divs = [
      { date: '2020-06-01', value: 10 },
      { date: '2021-06-01', value: 5 },
    ];
    const annual = calendarYearTotalReturns(prices, divs, [2020, 2021]);
    // 2020: price 100→110 = +10%, div 10% → total 20%
    expect(annual[2020]?.totalReturnPct).toBe(20);
    expect(annual[2020]?.dividendReturnPct).toBe(10);
  });
});

describe('trailingDyAndNextTotalReturn', () => {
  test('gera pares DY → TR seguinte', () => {
    const prices = [
      { date: '2020-01-02', close: 100 },
      { date: '2021-01-04', close: 100 },
      { date: '2022-01-03', close: 120 },
    ];
    const divs = [{ date: '2020-06-01', value: 8 }];
    const pairs = trailingDyAndNextTotalReturn(prices, divs, [2020]);
    expect(pairs.length).toBe(1);
    expect(pairs[0]!.trailingDyPct).toBe(8);
    // 2021: 100→120 = 20% price, 0 div
    expect(pairs[0]!.nextTotalReturnPct).toBe(20);
  });
});

describe('fii-backtest-analysis', () => {
  test('averageTotalReturnByYear', () => {
    const rows = [
      {
        ticker: 'A11',
        year: 2020,
        totalReturnPct: 10,
        priceReturnPct: 5,
        dividendReturnPct: 5,
      },
      {
        ticker: 'B11',
        year: 2020,
        totalReturnPct: 20,
        priceReturnPct: 10,
        dividendReturnPct: 10,
      },
    ];
    const avg = averageTotalReturnByYear(rows);
    expect(avg[0]!.avgTotal).toBe(15);
    expect(avg[0]!.n).toBe(2);
  });

  test('dyPredictsNextReturn', () => {
    const pairs = Array.from({ length: 6 }, (_, i) => ({
      ticker: 'X11',
      year: 2015 + i,
      trailingDyPct: i * 2,
      nextTotalReturnPct: i * 3,
    }));
    const r = dyPredictsNextReturn(pairs);
    expect(r.n).toBe(6);
    expect(r.correlation).toBeGreaterThan(0.9);
  });

  test('topNByScoreVsUniverse', () => {
    const rows = [
      {
        ticker: 'A11',
        year: 2020,
        totalReturnPct: 30,
        priceReturnPct: 20,
        dividendReturnPct: 10,
        score: 90,
      },
      {
        ticker: 'B11',
        year: 2020,
        totalReturnPct: 10,
        priceReturnPct: 5,
        dividendReturnPct: 5,
        score: 50,
      },
      {
        ticker: 'C11',
        year: 2020,
        totalReturnPct: 0,
        priceReturnPct: 0,
        dividendReturnPct: 0,
        score: 20,
      },
    ];
    const t = topNByScoreVsUniverse(rows, 1);
    expect(t.years[0]!.topAvg).toBe(30);
    expect(t.winYears).toBe(1);
  });
});
