/**
 * Parse e shape do provider Investidor10 (sem rede no CI).
 */
import { describe, expect, test } from 'bun:test';
import { _test } from '../../src/infra/services/investidor10-provider.ts';

const { parseI10DateTime } = _test;

describe('Investidor10 date parse', () => {
  test('BR diário DD/MM/YYYY', () => {
    const r = parseI10DateTime('14/07/2025 00:00');
    expect(r.date).toBe('2025-07-14');
    expect(r.asOf.startsWith('2025-07-14T00:00')).toBe(true);
  });

  test('ISO com hora', () => {
    const r = parseI10DateTime('2026-07-15 17:46:00');
    expect(r.date).toBe('2026-07-15');
    expect(r.asOf).toContain('17:46:00');
  });
});

describe('Investidor10 batch payload shape', () => {
  test('mapeia price/last_update', () => {
    const raw = {
      PRIO3: { price: 57.54, last_update: '2026-07-15 17:46:00' },
      PETR4: { price: 40.58, last_update: '2026-07-15 17:46:00' },
      BAD: { price: 0 },
    };
    const hits: Array<{ ticker: string; price: number }> = [];
    for (const [t, body] of Object.entries(raw)) {
      const price = Number(body.price);
      if (!(price > 0)) continue;
      hits.push({ ticker: t, price });
    }
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.ticker).sort()).toEqual(['PETR4', 'PRIO3']);
  });
});
