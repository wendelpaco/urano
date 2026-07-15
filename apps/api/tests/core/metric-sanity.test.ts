import { describe, it, expect } from 'bun:test';
import {
  flagAbsurdMetrics,
  hasAbsurdMetrics,
} from '../../src/core/services/metric-sanity.ts';

describe('flagAbsurdMetrics', () => {
  it('healthy metrics → no flags', () => {
    expect(
      flagAbsurdMetrics({ price: 36.5, pe: 12, dy: 3.2, pvp: 1.5 }),
    ).toEqual([]);
    expect(hasAbsurdMetrics({ price: 36.5, peRatio: 12, dividendYield: 3 })).toBe(false);
  });

  it('null price → price_missing', () => {
    const flags = flagAbsurdMetrics({ price: null });
    expect(flags.some((f) => f.code === 'price_missing')).toBe(true);
  });

  it('zero / negative price → price_non_positive', () => {
    expect(flagAbsurdMetrics({ price: 0 }).some((f) => f.code === 'price_non_positive')).toBe(true);
    expect(flagAbsurdMetrics({ price: -1 }).some((f) => f.code === 'price_non_positive')).toBe(true);
  });

  it('PE < 0 → pe_negative', () => {
    const flags = flagAbsurdMetrics({ pe: -5 });
    expect(flags).toHaveLength(1);
    expect(flags[0]!.code).toBe('pe_negative');
  });

  it('PE > 1000 → pe_absurd', () => {
    const flags = flagAbsurdMetrics({ peRatio: 1500 });
    expect(flags.some((f) => f.code === 'pe_absurd' && f.value === 1500)).toBe(true);
  });

  it('DY > 100 → dy_absurd', () => {
    const flags = flagAbsurdMetrics({ dy: 250 });
    expect(flags.some((f) => f.code === 'dy_absurd')).toBe(true);
  });

  it('accepts pl / dividendYield / pbRatio aliases', () => {
    const flags = flagAbsurdMetrics({ pl: 2000, dividendYield: 120, pbRatio: -0.5 });
    expect(flags.map((f) => f.code).sort()).toEqual(['dy_absurd', 'pe_absurd', 'pvp_negative']);
  });

  it('undefined fields are ignored (not flagged)', () => {
    expect(flagAbsurdMetrics({})).toEqual([]);
    expect(flagAbsurdMetrics({ pe: null, dy: null })).toEqual([]);
  });

  it('PE exactly 1000 is not absurd; 1000.01 is', () => {
    expect(flagAbsurdMetrics({ pe: 1000 })).toEqual([]);
    expect(flagAbsurdMetrics({ pe: 1000.01 }).some((f) => f.code === 'pe_absurd')).toBe(true);
  });
});
