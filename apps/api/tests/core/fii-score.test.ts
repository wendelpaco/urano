import { describe, it, expect } from 'bun:test';
import { FIIScoreCalculatorV4 } from '../../src/core/services/fii-score.ts';
import type { FIIScoreInput } from '../../src/core/services/fii-score.ts';

// Fixture base comum para todos os testes de FII
function makeMonthlyHistory(
  months: number,
  baseValue: number,
  variance = 0,
): Array<{ date: string; value: number; type: string }> {
  const events: Array<{ date: string; value: number; type: string }> = [];
  const now = new Date();
  for (let i = 0; i < months; i++) {
    const d = new Date(now);
    d.setMonth(d.getMonth() - i);
    d.setDate(15);
    const variation = variance > 0 ? (Math.random() - 0.5) * variance : 0;
    events.push({
      date: d.toISOString().slice(0, 10),
      value: baseValue + variation,
      type: 'RENDIMENTO',
    });
  }
  return events;
}

describe('FIIScoreV4 - Golden Tests', () => {
  // ─── KNCR11: CDI high-grade, juros sensitive ──────────────────────────

  it('KNCR11: deve classificar como papel, cdi_high_grade_juros_sensitive', () => {
    const input: FIIScoreInput = {
      ticker: 'KNCR11',
      price: 102.5,
      dy: 1.08, // ~12.96% a.a. → será normalizado para 10.5%
      pvp: 1,
      liquidity: 2_500_000,
      dividendsHistory: makeMonthlyHistory(24, 0.10, 0.01),
    };

    const result = FIIScoreCalculatorV4.calculate(input);

    expect(result.type).toBe('papel');
    expect(result.subclasse_papel).toBe('cdi_high_grade_juros_sensitive');
    expect(result.type_source).toBe('official_docs');

    // Score deve ser bom, mas penalizado pelo risco de juros (income=40%+asset=35%+risk=25%)
    expect(result.overall_score).toBeGreaterThanOrEqual(65);
    expect(result.overall_score).toBeLessThan(90);

    // Limitador deve ser risk (juros)
    expect(result.score_limiter).toBe('risk');

    // Contencao: score FII nao validado nao emite acao de investimento.
    expect(result.recommendation.action).toBe('analise_experimental');
    expect(result.metadata.validation_status).toBe('experimental_not_validated');
    expect(result.metadata.data_coverage.critical_complete).toBe(true);

    // Explicação deve mencionar CDI
    expect(result.explanation_short.toLowerCase()).toContain('cdi');
  });

  // ─── XPML11: Shopping prime cíclico ───────────────────────────────────

  it('XPML11: deve classificar como tijolo, shopping_prime_ciclico', () => {
    const input: FIIScoreInput = {
      ticker: 'XPML11',
      price: 105.0,
      dy: 0.65, // ~7.8% a.a.
      pvp: 1,
      liquidity: 3_000_000,
      dividendsHistory: makeMonthlyHistory(24, 0.065, 0.005),
      vacancy: 4,
      delinquency: 0,
    };

    const result = FIIScoreCalculatorV4.calculate(input);

    expect(result.type).toBe('tijolo');
    expect(result.subclasse_tijolo).toBe('shopping_prime_ciclico');
    expect(result.type_source).toBe('official_docs');

    // Score bom, mas com ajuste fino +1
    expect(result.overall_score).toBeGreaterThan(55);
    expect(result.overall_score).toBeLessThan(85);

    // Explicação deve mencionar consumo
    expect(result.explanation_short.toLowerCase()).toContain('consumo');
  });

  // ─── HGLG11: Logística defensiva ──────────────────────────────────────

  it('HGLG11: deve classificar como tijolo, logistica_defensiva', () => {
    const input: FIIScoreInput = {
      ticker: 'HGLG11',
      price: 165.0,
      dy: 0.72, // ~5.2% a.a.
      pvp: 1,
      liquidity: 5_000_000,
      dividendsHistory: makeMonthlyHistory(24, 0.72, 0.01),
      vacancy: 3,
      delinquency: 0,
    };

    const result = FIIScoreCalculatorV4.calculate(input);

    expect(result.type).toBe('tijolo');
    expect(result.subclasse_tijolo).toBe('logistica_defensiva');
    expect(result.type_source).toBe('official_docs');

    // Score alto: contratos longos + ajuste +2
    expect(result.overall_score).toBeGreaterThan(70);

    // Contencao: nem score alto vira recomendacao de compra.
    expect(result.recommendation.action).toBe('analise_experimental');

    // Explicação deve mencionar contratos ou risco controlado
    expect(result.explanation_short.toLowerCase()).toMatch(/contrato|risco controlado/);
  });

  // ─── Ticker não classificado: type inferido ───────────────────────────

  it('FII não classificado: type tijolo inferido com type_source inferred', () => {
    const input: FIIScoreInput = {
      ticker: 'ABCD11',
      price: 100,
      dy: 0.8,
      pvp: null,
      liquidity: 300_000,
      dividendsHistory: makeMonthlyHistory(12, 0.08),
    };

    const result = FIIScoreCalculatorV4.calculate(input);

    expect(result.type).toBe('tijolo');
    expect(result.type_source).toBe('inferred');
    expect(result.subclasse_papel).toBeNull();
    expect(result.subclasse_tijolo).toBeNull();

    // Sem classificacao e dados operacionais, o modelo se abstém com nota 0.
    expect(result.overall_score).toBe(0);
    expect(result.metadata.data_coverage.critical_complete).toBe(false);
    expect(result.metadata.data_coverage.missing_fields).toContain('classification');
    expect(result.metadata.data_coverage.missing_fields).toContain('vacancy');
  });

  // ─── Histórico curto: penalização ─────────────────────────────────────

  it('Histórico com menos de 6 meses: income quality ruim', () => {
    const input: FIIScoreInput = {
      ticker: 'KNCR11',
      price: 102,
      dy: 12,
      pvp: null,
      liquidity: 1_000_000,
      dividendsHistory: [
        { date: '2025-06-15', value: 0.10, type: 'RENDIMENTO' },
        { date: '2025-05-15', value: 0.10, type: 'RENDIMENTO' },
      ],
    };

    const result = FIIScoreCalculatorV4.calculate(input);

    expect(result.income_quality.rating).toBe('ruim');
    expect(result.income_quality.score).toBe(0);
    expect(result.metadata.data_coverage.missing_fields).toContain('dividends_history');
  });

  // ─── FII de papel high_grade: VGIR11 ──────────────────────────────────

  it('VGIR11: high_grade com sensibilidade a juros', () => {
    const input: FIIScoreInput = {
      ticker: 'VGIR11',
      price: 10.5,
      dy: 1.1, // será normalizado para max 11.0%
      pvp: null,
      liquidity: 1_200_000,
      dividendsHistory: makeMonthlyHistory(24, 0.09, 0.005),
    };

    const result = FIIScoreCalculatorV4.calculate(input);

    expect(result.type).toBe('papel');
    expect(result.subclasse_papel).toBe('high_grade');
    expect(result.risk.primary_risk).toContain('Selic');
  });

  it('remover dado critico nunca aumenta o score', () => {
    const complete: FIIScoreInput = {
      ticker: 'HGLG11',
      price: 165,
      dy: 8,
      pvp: 1,
      liquidity: 5_000_000,
      dividendsHistory: makeMonthlyHistory(12, 0.72),
      vacancy: 3,
      delinquency: 0,
    };
    const baseline = FIIScoreCalculatorV4.calculate(complete);
    expect(baseline.metadata.data_coverage.critical_complete).toBe(true);

    const incompleteInputs: FIIScoreInput[] = [
      { ...complete, pvp: null },
      { ...complete, liquidity: null },
      { ...complete, dividendsHistory: [] },
      { ...complete, vacancy: undefined },
      { ...complete, delinquency: undefined },
    ];

    for (const input of incompleteInputs) {
      const result = FIIScoreCalculatorV4.calculate(input);
      expect(result.overall_score).toBeLessThanOrEqual(baseline.overall_score);
      expect(result.metadata.data_coverage.percent)
        .toBeLessThan(baseline.metadata.data_coverage.percent);
      expect(result.missing_data_penalty).toBeGreaterThan(0);
    }
  });

  it('ausencia recebe pior caso, nunca defaults otimistas', () => {
    const result = FIIScoreCalculatorV4.calculate({
      ticker: 'HGLG11',
      price: 165,
      dy: 8,
      pvp: null,
      liquidity: null,
      dividendsHistory: [],
    });

    expect(result.asset_quality.valuation_score).toBe(0);
    expect(result.asset_quality.liquidity_score).toBe(0);
    expect(result.risk.breakdown.vacancia).toBe(0);
    expect(result.risk.breakdown.liquidez).toBe(0);
    expect(result.metadata.data_coverage.policy).toBe('worst_case_plus_penalty');
  });

  it('multiplos eventos no mesmo mes nao fingem seis meses de historico', () => {
    const sameMonth = Array.from({ length: 6 }, (_, index) => ({
      date: `2026-06-${String(index + 1).padStart(2, '0')}`,
      value: 0.1,
      type: 'RENDIMENTO',
    }));
    const result = FIIScoreCalculatorV4.calculate({
      ticker: 'HGLG11',
      price: 160,
      dy: 8,
      pvp: 1,
      liquidity: 2_000_000,
      dividendsHistory: sameMonth,
      vacancy: 3,
      delinquency: 0,
    });

    expect(result.income_quality.score).toBe(0);
    expect(result.metadata.data_coverage.missing_fields).toContain('dividends_history');
  });

  it('amortizacao nao melhora qualidade de renda nem cobertura', () => {
    const income = makeMonthlyHistory(6, 0.7);
    const baseline = FIIScoreCalculatorV4.calculate({
      ticker: 'HGLG11', price: 160, dy: 8, pvp: 1, liquidity: 2_000_000,
      dividendsHistory: income, vacancy: 3, delinquency: 0,
    });
    const withAmortization = FIIScoreCalculatorV4.calculate({
      ticker: 'HGLG11', price: 160, dy: 8, pvp: 1, liquidity: 2_000_000,
      dividendsHistory: [
        ...income,
        { date: income[0]!.date, value: 50, type: 'AMORTIZACAO' },
      ],
      vacancy: 3,
      delinquency: 0,
    });

    expect(withAmortization.income_quality).toEqual(baseline.income_quality);
    expect(withAmortization.metadata.data_coverage)
      .toEqual(baseline.metadata.data_coverage);
  });

  it('nao confunde FoF/recebiveis com segmentos fisicos', () => {
    const base = {
      price: 100,
      dy: 8,
      pvp: 1,
      liquidity: 2_000_000,
      dividendsHistory: makeMonthlyHistory(12, 0.7),
    };

    expect(FIIScoreCalculatorV4.calculate({ ...base, ticker: 'BCFF11' }).type)
      .toBe('hibrido');
    expect(FIIScoreCalculatorV4.calculate({ ...base, ticker: 'CPTS11' }).type)
      .toBe('papel');
    expect(FIIScoreCalculatorV4.calculate({ ...base, ticker: 'RBRR11' }).type)
      .toBe('papel');
    expect(FIIScoreCalculatorV4.calculate({
      ...base,
      ticker: 'BRCO11',
      vacancy: 3,
      delinquency: 0,
    }).subclasse_tijolo).toBe('logistica_defensiva');
    expect(FIIScoreCalculatorV4.calculate({
      ...base,
      ticker: 'HGBS11',
      vacancy: 3,
      delinquency: 0,
    }).subclasse_tijolo).toBe('shopping_prime_ciclico');
  });
});
