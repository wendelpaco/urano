import { describe, it, expect } from 'bun:test';
import { calcAllIndicators } from '../../src/core/services/indicators.ts';

// Fixture que simula uma linha do banco (snake_case, como o Drizzle retorna)
function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ticker: 'PETR4',
    referenceDate: '2024-12-31',
    netIncome: 100_000_000_000,
    netIncomeParent: 100_000_000_000,
    revenue: 500_000_000_000,
    cogs: -300_000_000_000, // CVM reporta negativo
    ebit: 150_000_000_000,
    totalAssets: 1_000_000_000_000,
    totalLiabilities: 600_000_000_000,
    cash: 50_000_000_000,
    operatingCashFlow: 120_000_000_000,
    equity: 400_000_000_000,
    sharesOutstanding: 13_000_000_000,
    ...overrides,
  };
}

describe('calcAllIndicators', () => {
  // ─── Golden test: PETR4 com dados simulados ────────────────────────────

  it('deve calcular DY a partir de dividendos/JCP CVM quando há preço e ações', () => {
    const price = 10;
    const row = makeRow({
      sharesOutstanding: 100,
      dividendsPaid: 50,
      jcpPaid: 50,
    });
    // DY = 100 / (100 * 10) * 100 = 10%
    const result = calcAllIndicators(row, price);
    expect(result.dividendYield).toBe(10);
  });

  it('deve calcular indicadores corretamente para empresa saudável', () => {
    const price = 35.0;
    const row = makeRow();
    const result = calcAllIndicators(row, price);

    expect(result.ticker).toBe('PETR4');
    expect(result.referenceDate).toBe('2024-12-31');

    // Margens
    expect(result.grossMargin).toBe(40); // (500 - 300) / 500 = 0.4 = 40%
    expect(result.ebitMargin).toBe(30);  // 150 / 500 = 30%
    expect(result.netMargin).toBe(20);   // 100 / 500 = 20%

    // ROE = 100B / 400B = 25%
    expect(result.roe).toBe(25);
    // ROA = 100B / 1T = 10%
    expect(result.roa).toBe(10);

    // Per-share
    expect(result.eps).toBe(7.69);  // 100B / 13B
    expect(result.bvps).toBe(30.77); // 400B / 13B

    // Valuation
    expect(result.peRatio).toBe(4.55);  // 35 / 7.69
    expect(result.pbRatio).toBe(1.14);  // 35 / 30.77

    // Market cap
    expect(result.marketCap).toBe(455_000_000_000); // 13B × 35

    // EV/EBIT = (marketCap 455B + netDebt 550B) / EBIT 150B = 6.7
    // (sensível ao preço; NÃO é Ativo/EBIT = 1T/150B = 6.67)
    expect(result.evEbit).toBe(6.7);

    // DY ainda null (calculado externamente)
    expect(result.dividendYield).toBeNull();
  });

  // ─── EV/EBIT sensível ao preço ─────────────────────────────────────────

  it('deve calcular EV/EBIT sensível ao preço (não Ativo/EBIT)', () => {
    const row = makeRow();
    const low = calcAllIndicators(row, 35).evEbit;
    const high = calcAllIndicators(row, 70).evEbit;
    // Preço maior → EV maior → EV/EBIT maior. O bug antigo (Ativo/EBIT) era invariante.
    expect(low).not.toBeNull();
    expect(high).not.toBeNull();
    expect(high as number).toBeGreaterThan(low as number);
    // Ativo/EBIT daria 6.67 e não mudaria com preço — garante que não regredimos.
    expect(low).not.toBe(6.67);
  });

  // ─── Empresa sem receita ───────────────────────────────────────────────

  it('deve retornar null em margens quando receita é zero', () => {
    const row = makeRow({ revenue: 0, cogs: 0 });
    const result = calcAllIndicators(row, 10);

    expect(result.grossMargin).toBeNull();
    expect(result.ebitMargin).toBeNull();
    expect(result.netMargin).toBeNull();
  });

  // ─── Empresa com prejuízo ──────────────────────────────────────────────

  it('deve retornar EPS negativo quando há prejuízo', () => {
    const row = makeRow({
      netIncome: -50_000_000_000,
      netIncomeParent: -50_000_000_000,
    });
    const result = calcAllIndicators(row, 10);

    expect(result.eps).toBeLessThan(0);
    expect(result.peRatio).toBeNull(); // P/L negativo → null
    expect(result.roe).toBeLessThan(0);
  });

  // ─── Empresa endividada ────────────────────────────────────────────────

  it('deve reportar endividamento elevado', () => {
    const row = makeRow({
      totalLiabilities: 1_200_000_000_000,
      equity: 300_000_000_000,
      cash: 0,
    });
    const result = calcAllIndicators(row, 10);

    // D/E = 1.2T / 300B = 4.0
    expect(result.debtToEquity).toBe(4);
    expect(result.netDebtToEquity).toBe(4); // netDebt = 1.2T - 0 = 1.2T
  });

  // ─── Sem cotação (price = 0) ───────────────────────────────────────────

  it('deve retornar métricas per-share mas valuation null sem price', () => {
    const row = makeRow();
    const result = calcAllIndicators(row, 0);

    expect(result.eps).toBeGreaterThan(0);
    expect(result.peRatio).toBeNull();
    expect(result.pbRatio).toBeNull();
    expect(result.marketCap).toBe(0);
    expect(result.evEbit).toBeNull(); // sem preço não há EV
  });

  // ─── COGS negativo (padrão CVM) ────────────────────────────────────────

  it('deve converter COGS negativo para positivo (padrão CVM)', () => {
    const row = makeRow({ revenue: 1000, cogs: -600 });
    const result = calcAllIndicators(row, 10);

    expect(result.grossMargin).toBe(40); // (1000 - 600) / 1000
  });
});
