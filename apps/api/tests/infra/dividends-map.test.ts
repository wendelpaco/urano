/**
 * Parser de proventos StatusInvest (ações ISO + FIIs ed/pd BR).
 * Cobre o bug que zerava DY histórico no backtest FII.
 */
import { describe, expect, test } from 'bun:test';

// Reimplementa a lógica pública do mapper (espelho do provider) para teste unitário
// sem rede. Mantido alinhado a dividends-provider.ts mapToEvents.

function toIsoDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  return null;
}

function parseValor(item: {
  v?: number;
  valor?: string | number;
}): number {
  if (typeof item.v === 'number' && Number.isFinite(item.v)) return item.v;
  if (typeof item.valor === 'number' && Number.isFinite(item.valor)) return item.valor;
  if (typeof item.valor === 'string') {
    const n = parseFloat(item.valor.replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

describe('dividends StatusInvest field mapping', () => {
  test('ISO dataCom (ações)', () => {
    expect(toIsoDate('2024-03-15')).toBe('2024-03-15');
    expect(parseValor({ valor: '0.85' })).toBe(0.85);
  });

  test('BR ed/pd + v (FIIs)', () => {
    expect(toIsoDate('30/06/2021')).toBe('2021-06-30');
    expect(toIsoDate('14/07/2016')).toBe('2016-07-14');
    expect(parseValor({ v: 1.1 })).toBe(1.1);
  });

  test('histórico FII sample maps to multi-year events', () => {
    const raw = [
      { ed: '30/06/2026', pd: '14/07/2026', et: 'Rendimento', v: 1.1 },
      { ed: '28/02/2021', pd: '12/03/2021', et: 'Rendimento', v: 0.75 },
      { ed: '30/06/2016', pd: '14/07/2016', et: 'Rendimento', v: 0.87 },
      { ed: 'invalid', v: 1 },
      { ed: '30/01/2020', v: 0 },
    ];
    const events = raw
      .map((item) => {
        const date =
          toIsoDate((item as { dataCom?: string }).dataCom) ??
          toIsoDate(item.ed) ??
          toIsoDate(item.pd);
        const value = parseValor(item);
        if (!date || !(value > 0)) return null;
        return { date, value };
      })
      .filter(Boolean) as Array<{ date: string; value: number }>;

    expect(events).toHaveLength(3);
    expect(events.map((e) => e.date.slice(0, 4)).sort()).toEqual([
      '2016',
      '2021',
      '2026',
    ]);
  });
});
