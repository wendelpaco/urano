import { describe, it, expect } from 'bun:test';
import { DividendsAnalyzer, type DividendEvent } from '../../src/core/services/dividends-analyzer.ts';

// Fixtures
function makeDate(offsetMonths: number, day = 15): string {
  const d = new Date();
  d.setMonth(d.getMonth() + offsetMonths);
  d.setDate(day);
  return d.toISOString().slice(0, 10);
}

// KNCR11-like: FII com pagamento mensal estável
function kncrLike(): DividendEvent[] {
  const events: DividendEvent[] = [];
  // 24 meses de histórico, ~R$0.10/cota/mês com leve variação
  for (let i = -24; i < 0; i++) {
    events.push({
      date: makeDate(i),
      value: 0.10 + Math.sin(i * 0.5) * 0.01,
      type: 'RENDIMENTO',
    });
  }
  return events;
}

// Empresa com pagamentos anuais consistentes
function annualPayer(): DividendEvent[] {
  return [
    { date: makeDate(-2), value: 0.50, type: 'DIVIDEND' },
    { date: makeDate(-14), value: 0.45, type: 'DIVIDEND' },
    { date: makeDate(-26), value: 0.42, type: 'DIVIDEND' },
    { date: makeDate(-38), value: 0.40, type: 'DIVIDEND' },
  ];
}

describe('DividendsAnalyzer', () => {
  // ---------------------------------------------------------------------------
  // Estabilidade
  // ---------------------------------------------------------------------------
  it('deve retornar estabilidade alta para pagamentos constantes (FII mensal)', () => {
    const analysis = DividendsAnalyzer.analyze(kncrLike());
    expect(analysis).not.toBeNull();
    expect(analysis!.stability).toBeGreaterThan(0.90);
  });

  it('deve retornar estabilidade baixa para histórico com gaps', () => {
    const events: DividendEvent[] = [
      { date: makeDate(-1), value: 2.00, type: 'DIVIDEND' },
      { date: makeDate(-6), value: 0.10, type: 'DIVIDEND' },
      { date: makeDate(-12), value: 1.50, type: 'DIVIDEND' },
      { date: makeDate(-18), value: 0.05, type: 'DIVIDEND' },
    ];
    const analysis = DividendsAnalyzer.analyze(events);
    expect(analysis).not.toBeNull();
    expect(analysis!.stability).toBeLessThan(0.5);
  });

  it('deve retornar estabilidade neutra com um único evento', () => {
    const events: DividendEvent[] = [
      { date: makeDate(-1), value: 0.50, type: 'DIVIDEND' },
    ];
    const analysis = DividendsAnalyzer.analyze(events);
    expect(analysis).not.toBeNull();
    expect(analysis!.stability).toBe(0.5);
  });

  // ---------------------------------------------------------------------------
  // Consistência
  // ---------------------------------------------------------------------------
  it('deve retornar consistência alta para pagador mensal', () => {
    const analysis = DividendsAnalyzer.analyze(kncrLike());
    expect(analysis).not.toBeNull();
    expect(analysis!.consistency).toBeGreaterThan(0.80);
  });

  it('deve retornar consistência baixa para pagador anual', () => {
    const analysis = DividendsAnalyzer.analyze(annualPayer());
    expect(analysis).not.toBeNull();
    expect(analysis!.consistency).toBeLessThan(0.3);
  });

  // ---------------------------------------------------------------------------
  // Tendência
  // ---------------------------------------------------------------------------
  it('deve retornar tendência positiva para histórico crescente', () => {
    const events: DividendEvent[] = [];
    for (let i = -12; i < 0; i++) {
      events.push({
        date: makeDate(i),
        value: 0.05 + (i + 12) * 0.01, // Cresce linearmente
        type: 'RENDIMENTO',
      });
    }
    const analysis = DividendsAnalyzer.analyze(events);
    expect(analysis).not.toBeNull();
    expect(analysis!.trend).toBeGreaterThan(0);
  });

  it('deve retornar tendência negativa para histórico decrescente', () => {
    const events: DividendEvent[] = [];
    for (let i = -12; i < 0; i++) {
      events.push({
        date: makeDate(i),
        value: 0.15 - (i + 12) * 0.01, // Decresce linearmente
        type: 'RENDIMENTO',
      });
    }
    const analysis = DividendsAnalyzer.analyze(events);
    expect(analysis).not.toBeNull();
    expect(analysis!.trend).toBeLessThan(0);
  });

  // ---------------------------------------------------------------------------
  // Score de qualidade
  // ---------------------------------------------------------------------------
  it('deve retornar quality alto para KNCR-like (estável + consistente)', () => {
    const analysis = DividendsAnalyzer.analyze(kncrLike());
    expect(analysis).not.toBeNull();
    expect(analysis!.quality).toBeGreaterThan(75);
  });

  it('deve retornar quality baixo para histórico decrescente com gaps', () => {
    const events: DividendEvent[] = [
      { date: makeDate(-1), value: 0.05, type: 'DIVIDEND' },
      { date: makeDate(-8), value: 0.50, type: 'DIVIDEND' },
    ];
    const analysis = DividendsAnalyzer.analyze(events);
    expect(analysis).not.toBeNull();
    expect(analysis!.quality).toBeLessThan(50);
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------
  it('deve retornar null para array vazio', () => {
    expect(DividendsAnalyzer.analyze([])).toBeNull();
  });

  it('deve calcular sum12m corretamente', () => {
    const analysis = DividendsAnalyzer.analyze(kncrLike());
    // 24 eventos de ~0.10 → 12m ≈ 12 × 0.10 = ~1.20
    expect(analysis!.sum12m).toBeGreaterThan(1.0);
    expect(analysis!.sum12m).toBeLessThan(1.5);
  });

  it('deve preencher period com datas do primeiro e último evento na janela', () => {
    const events = annualPayer();
    const analysis = DividendsAnalyzer.analyze(events);
    // annualPayer gera eventos em -2, -14, -26, -38 meses.
    // Com lookback padrão de 24 meses, só -2 e -14 entram.
    expect(analysis!.period.start).toBe(makeDate(-14));
    expect(analysis!.period.end).toBe(makeDate(-2));
  });

  it('deve ordenar eventos internamente (datas fora de ordem)', () => {
    const events: DividendEvent[] = [
      { date: makeDate(-6), value: 0.30, type: 'DIVIDEND' },
      { date: makeDate(-1), value: 0.40, type: 'DIVIDEND' },
      { date: makeDate(-12), value: 0.20, type: 'DIVIDEND' },
    ];
    const analysis = DividendsAnalyzer.analyze(events);
    expect(analysis!.period.start).toBe(makeDate(-12));
    expect(analysis!.period.end).toBe(makeDate(-1));
  });
});
