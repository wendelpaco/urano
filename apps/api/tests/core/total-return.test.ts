import { describe, expect, test } from 'bun:test';
import {
  computeTotalReturn,
  momentumFromCloses,
} from '../../src/core/services/total-return.ts';

describe('computeTotalReturn', () => {
  test('soma preço + proventos cash', () => {
    const prices = [
      { date: '2024-01-02', close: 100 },
      { date: '2024-06-01', close: 110 },
      { date: '2024-12-30', close: 120 },
    ];
    const divs = [
      { date: '2024-03-01', value: 2 },
      { date: '2024-09-01', value: 3 },
    ];
    const tr = computeTotalReturn(prices, divs);
    expect(tr).not.toBeNull();
    expect(tr!.priceReturnPct).toBe(20);
    expect(tr!.dividendReturnPct).toBe(5);
    expect(tr!.totalReturnPct).toBe(25);
    expect(tr!.dividendEvents).toBe(2);
  });

  test('retorna null com série curta', () => {
    expect(computeTotalReturn([{ date: '2024-01-01', close: 10 }], [])).toBeNull();
  });
});

describe('momentumFromCloses', () => {
  test('calcula 6m com série mensal sintética', () => {
    const prices = [];
    for (let m = 1; m <= 12; m++) {
      prices.push({
        date: `2024-${String(m).padStart(2, '0')}-15`,
        close: 100 + m,
      });
    }
    const mom = momentumFromCloses(prices, '2024-12-15');
    expect(mom.return6m).not.toBeNull();
    // ~ de jun (106) a dez (112) ≈ 5.7%
    expect(mom.return6m!).toBeGreaterThan(0);
  });
});
