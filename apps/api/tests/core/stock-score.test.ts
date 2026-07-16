import { describe, it, expect } from 'bun:test';
import { StockScoreCalculator } from '../../src/core/services/stock-score.ts';
import type { FinancialIndicators } from '../../src/core/entities/company-fundamentals.ts';

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** PETR4-like: empresa saudável, lucrativa, pouco endividada */
function healthyCompany(): FinancialIndicators {
  return {
    ticker: 'WEGE3',
    referenceDate: '2024-12-31',
    grossMargin: 45.2,
    ebitMargin: 25.8,
    netMargin: 20.1,
    roe: 28.5,
    roa: 15.3,
    roic: 18.5,
    peRatio: 12.0,
    pbRatio: 2.5,
    psRatio: 2.0,
    pebit: 10.0,
    evEbit: 12.0,
    debtToEquity: 0.3,
    netDebtToEquity: 0.1,
    eps: 3.0,
    bvps: 14.0,
    assetTurnover: 0.75,
    fcoToNetIncome: 1.1,
    marketCap: 150_000_000_000,
    dividendYield: 1.5,
  };
}

/** Empresa endividada, margens apertadas */
function indebtedCompany(): FinancialIndicators {
  return {
    ticker: 'DEBT3',
    referenceDate: '2024-12-31',
    grossMargin: 25.0,
    ebitMargin: 12.0,
    netMargin: 3.5,
    roe: 5.0,
    roa: 1.5,
    roic: 4.2,
    peRatio: 18.0,
    pbRatio: 0.9,
    psRatio: 0.6,
    pebit: 10.0,
    evEbit: 15.0,
    debtToEquity: 3.5,
    netDebtToEquity: 3.0,
    eps: 0.5,
    bvps: 10.0,
    assetTurnover: 0.4,
    fcoToNetIncome: 0.4,
    marketCap: 50_000_000_000,
    dividendYield: 2.0,
  };
}

/** Empresa com prejuízo */
function lossCompany(): FinancialIndicators {
  return {
    ticker: 'LOSS3',
    referenceDate: '2024-12-31',
    grossMargin: 15.0,
    ebitMargin: -5.0,
    netMargin: -12.0,
    roe: -20.0,
    roa: -8.0,
    roic: -5.0,
    peRatio: null,
    pbRatio: 0.5,
    psRatio: 0.3,
    pebit: null,
    evEbit: null,
    debtToEquity: 2.5,
    netDebtToEquity: 2.0,
    eps: -1.8,
    bvps: 8.0,
    assetTurnover: 0.3,
    fcoToNetIncome: -0.5,
    marketCap: 20_000_000_000,
    dividendYield: null,
  };
}

// ─── Testes ──────────────────────────────────────────────────────────────────

describe('StockScoreCalculator', () => {
  // ─── Empresa saudável (WEGE3-like) ─────────────────────────────────────

  it('deve retornar score alto para empresa saudável e defensiva', () => {
    const result = StockScoreCalculator.calculate(
      healthyCompany(),
      'saneamento',
      'WEG S.A.',
      // IMP-3r: fornece histórico mínimo para evitar penalidade de cobertura
      { years: [{ fiscalYear: 2023, revenue: 5000, netIncome: 1000, roe: 25, netMargin: 18, debtToEquity: 0.3, grossMargin: 42 }, { fiscalYear: 2024, revenue: 5800, netIncome: 1200, roe: 28, netMargin: 20, debtToEquity: 0.3, grossMargin: 45 }] },
      { ticker: 'WEGE3', price: 42, return3m: -2, return6m: 5, drawdownFrom52WeekHigh: 8, annualizedVolatility: 22, avgVolume: 5000000 },
    );

    expect(result.score).toBeGreaterThan(55);
    expect(result.ticker).toBe('WEGE3');

    // Breakdown deve ter todos os pilares
    expect(result.breakdown.valuation.score).toBeGreaterThan(0);
    expect(result.breakdown.profitability.score).toBeGreaterThan(0);
    expect(result.breakdown.dividends.score).toBeGreaterThan(0);
    expect(result.breakdown.quality.score).toBeGreaterThan(0);

    // Reasons deve ter pontos positivos
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  // ─── Empresa endividada ────────────────────────────────────────────────

  it('deve retornar score baixo/médio para empresa endividada', () => {
    const result = StockScoreCalculator.calculate(
      indebtedCompany(),
      'construção',
      'Construtora Endividada S.A.',
    );

    expect(result.score).toBeLessThan(60);

    // Deve alertar sobre endividamento
    const hasDebtAlert = result.alerts.some((a) =>
      a.toLowerCase().includes('endividamento'),
    );
    expect(hasDebtAlert).toBe(true);

    // Setor cíclico deve aparecer nos alerts
    const hasCyclicalAlert = result.alerts.some((a) =>
      a.toLowerCase().includes('cíclico'),
    );
    expect(hasCyclicalAlert).toBe(true);
  });

  // ─── Empresa com prejuízo ──────────────────────────────────────────────

  it('deve retornar score baixo para empresa com prejuízo', () => {
    const result = StockScoreCalculator.calculate(
      lossCompany(),
      'varejo',
      'Varejista com Prejuízo S.A.',
    );

    expect(result.score).toBeLessThan(40);

    // Deve ter alerta de prejuízo
    const hasLossAlert = result.alerts.some(
      (a) =>
        a.toLowerCase().includes('prejuízo') ||
        a.toLowerCase().includes('eps negativo'),
    );
    expect(hasLossAlert).toBe(true);

    // Valuation deve ser penalizado
    expect(result.breakdown.valuation.score).toBeLessThanOrEqual(25);
  });

  // ─── Setor defensivo vs cíclico ────────────────────────────────────────

  it('deve pontuar melhor setor defensivo que cíclico (tudo mais igual)', () => {
    const indicators = healthyCompany();

    const defensive = StockScoreCalculator.calculate(
      indicators,
      'saneamento',
      'Saneamento Defensivo',
    );
    const cyclical = StockScoreCalculator.calculate(
      indicators,
      'construção',
      'Construção Cíclica',
    );

    // Qualidade deve ser maior no defensivo
    expect(defensive.breakdown.quality.score).toBeGreaterThan(
      cyclical.breakdown.quality.score,
    );

    // Cíclico deve ter alerta
    expect(cyclical.alerts.some((a) => a.toLowerCase().includes('cíclico'))).toBe(
      true,
    );
  });

  // ─── DY alto vs baixo ──────────────────────────────────────────────────

  it('deve pontuar melhor DY alto que baixo', () => {
    const highDY = { ...healthyCompany(), dividendYield: 9.0 };
    const lowDY = { ...healthyCompany(), dividendYield: 1.0 };

    const high = StockScoreCalculator.calculate(highDY, null, 'High DY');
    const low = StockScoreCalculator.calculate(lowDY, null, 'Low DY');

    expect(high.breakdown.dividends.score).toBeGreaterThan(
      low.breakdown.dividends.score,
    );
  });

  // ─── DY null (indisponível) ────────────────────────────────────────────

  it('deve penalizar ausência de DY', () => {
    const result = StockScoreCalculator.calculate(
      { ...healthyCompany(), dividendYield: null },
      null,
      'Sem DY',
    );

    expect(result.breakdown.dividends.score).toBe(30);
    expect(result.alerts.some((a) => a.includes('indisponível'))).toBe(true);
  });

  // ─── P/L muito baixo (barganha) ────────────────────────────────────────

  it('deve pontuar valuation alto para P/L baixo', () => {
    const cheap = { ...healthyCompany(), peRatio: 6.0 };
    const result = StockScoreCalculator.calculate(
      cheap,
      null,
      'Empresa Barata',
    );

    expect(result.breakdown.valuation.score).toBeGreaterThan(50);
    expect(result.reasons.some((r) => r.includes('Earnings Yield') || r.includes('P/L'))).toBe(true);
  });

  // ─── Scores dentro de 0-100 ────────────────────────────────────────────

  it('todos os scores devem estar no intervalo 0-100', () => {
    const testCases = [
      { ind: healthyCompany(), sector: 'energia', name: 'WEG' },
      { ind: indebtedCompany(), sector: 'construção', name: 'DEBT' },
      { ind: lossCompany(), sector: 'varejo', name: 'LOSS' },
    ];

    for (const tc of testCases) {
      const result = StockScoreCalculator.calculate(tc.ind, tc.sector, tc.name);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);

      for (const pillar of Object.values(result.breakdown)) {
        expect(pillar.score).toBeGreaterThanOrEqual(0);
        expect(pillar.score).toBeLessThanOrEqual(100);
      }
    }
  });
});
