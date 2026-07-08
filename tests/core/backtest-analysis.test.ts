import { describe, it, expect } from 'bun:test';
import {
  percentile,
  pearson,
  pillarCorrelations,
  scoreBuckets,
  topNStrategy,
  type BacktestRow,
} from '../../src/core/services/backtest-analysis.ts';

function row(partial: Partial<BacktestRow>): BacktestRow {
  return {
    year: 2020, ticker: 'AAAA3', score: 50,
    valuation: 50, profitability: 50, growth: 50,
    dividends: 50, quality: 50, momentum: 50,
    return12m: 0,
    ...partial,
  };
}

describe('percentile', () => {
  it('calcula mediana e extremos', () => {
    const arr = [10, 20, 30, 40, 50];
    expect(percentile(arr, 50)).toBe(30);
    expect(percentile(arr, 100)).toBe(50);
  });
});

describe('pearson', () => {
  it('correlação perfeita positiva = 1', () => {
    expect(pearson([1, 2, 3, 4], [10, 20, 30, 40])).toBe(1);
  });
  it('correlação perfeita negativa = -1', () => {
    expect(pearson([1, 2, 3, 4], [40, 30, 20, 10])).toBe(-1);
  });
  it('série constante retorna 0 (sem variância)', () => {
    expect(pearson([5, 5, 5], [1, 2, 3])).toBe(0);
  });
});

describe('pillarCorrelations', () => {
  it('pilar alinhado com retorno tem correlação 1, ignora return12m null', () => {
    const rows: BacktestRow[] = [
      row({ ticker: 'AAAA3', score: 10, return12m: -10 }),
      row({ ticker: 'BBBB3', score: 50, return12m: 20 }),
      row({ ticker: 'CCCC3', score: 90, return12m: 50 }),
      row({ ticker: 'DDDD3', score: 99, return12m: null }), // ignorada
    ];
    const corrs = pillarCorrelations(rows);
    expect(corrs.score).toBeGreaterThan(0.9);
    // pilares constantes (50 em todas) → 0
    expect(corrs.quality).toBe(0);
  });
});

describe('scoreBuckets', () => {
  it('agrupa por faixa de 10 e calcula estatísticas', () => {
    const rows: BacktestRow[] = [
      row({ ticker: 'AAAA3', score: 72, return12m: 10 }),
      row({ ticker: 'BBBB3', score: 78, return12m: 30 }),
      row({ ticker: 'CCCC3', score: 35, return12m: -20 }),
    ];
    const buckets = scoreBuckets(rows);
    const b70 = buckets.find((b) => b.label === '70-80');
    expect(b70?.count).toBe(2);
    expect(b70?.avgReturn).toBe(20);
    expect(b70?.pctPositive).toBe(100);
    expect(b70?.bestTicker).toBe('BBBB3 2020');
    expect(buckets.find((b) => b.label === '30-40')?.count).toBe(1);
  });
});

describe('topNStrategy', () => {
  it('seleciona top N por score em cada ano e compara com a média do ano', () => {
    const rows: BacktestRow[] = [
      row({ year: 2020, ticker: 'AAAA3', score: 90, return12m: 40 }),
      row({ year: 2020, ticker: 'BBBB3', score: 80, return12m: 20 }),
      row({ year: 2020, ticker: 'CCCC3', score: 10, return12m: -30 }),
      row({ year: 2021, ticker: 'AAAA3', score: 85, return12m: 10 }),
      row({ year: 2021, ticker: 'BBBB3', score: 20, return12m: -10 }),
    ];
    const result = topNStrategy(rows, 2);
    expect(result.totalYears).toBe(2);
    // 2020: top2 = AAAA3+BBBB3 → (40+20)/2 = 30; mercado = (40+20-30)/3 = 10
    expect(result.years[0]?.portfolioReturn).toBe(30);
    expect(result.years[0]?.marketReturn).toBe(10);
    // 2021: top2 = ambas → portfolio = mercado = 0
    expect(result.years[1]?.portfolioReturn).toBe(0);
    expect(result.winYears).toBe(1); // só 2020 ganha do mercado
    expect(result.avgPortfolio).toBe(15);
  });
});
