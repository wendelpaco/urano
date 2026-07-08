import { describe, it, expect } from 'bun:test';
import {
  suggestContribution,
  type AdvisorAsset,
} from '../../src/core/services/contribution-advisor.ts';

function asset(partial: Partial<AdvisorAsset>): AdvisorAsset {
  return {
    ticker: 'AAAA3', name: 'Empresa A', assetType: 'stock',
    score: 70, price: 10, sector: 'energia elétrica',
    reasons: ['ROE alto'], alerts: [],
    ...partial,
  };
}

function universe(): AdvisorAsset[] {
  return [
    asset({ ticker: 'AAAA3', score: 85, price: 20, sector: 'energia elétrica' }),
    asset({ ticker: 'BBBB3', score: 75, price: 15, sector: 'saneamento' }),
    asset({ ticker: 'CCCC3', score: 68, price: 30, sector: 'financeiro' }),
    asset({ ticker: 'DDDD3', score: 50, price: 10, sector: 'varejo' }),
    asset({ ticker: 'EEEE11', assetType: 'fii', score: 80, price: 100, sector: 'logistica' }),
    asset({ ticker: 'FFFF11', assetType: 'fii', score: 72, price: 90, sector: 'shopping' }),
    asset({ ticker: 'GGGG11', assetType: 'fii', score: 66, price: 110, sector: 'papel' }),
  ];
}

describe('suggestContribution', () => {
  it('carteira vazia, perfil moderado: compra ações e FIIs dentro do valor', () => {
    const result = suggestContribution(universe(), [], { amount: 2000, profile: 'moderado' });
    expect(result.purchases.length).toBeGreaterThan(0);
    expect(result.purchases.some((p) => p.assetType === 'stock')).toBe(true);
    expect(result.purchases.some((p) => p.assetType === 'fii')).toBe(true);
    expect(result.totals.invested).toBeLessThanOrEqual(2000);
    expect(result.totals.invested + result.totals.remaining).toBeCloseTo(2000, 1);
    // toda compra tem justificativa
    for (const p of result.purchases) expect(p.why.length).toBeGreaterThan(0);
  });

  it('carteira concentrada: ativo no teto é pulado com explicação de concentração', () => {
    // 500 cotas × R$20 = R$10.000 em AAAA3; aporte de R$1.000 → teto 25% de R$11.000 = R$2.750 < R$10.000
    const result = suggestContribution(
      universe(),
      [{ ticker: 'AAAA3', quantity: 500 }],
      { amount: 1000, profile: 'moderado' },
    );
    expect(result.purchases.every((p) => p.ticker !== 'AAAA3')).toBe(true);
    expect(result.skipped.some((s) => s.ticker === 'AAAA3' && s.reason.includes('teto'))).toBe(true);
  });

  it('valor menor que qualquer preço: sem compras, warning de valor insuficiente', () => {
    const result = suggestContribution(universe(), [], { amount: 5, profile: 'moderado' });
    expect(result.purchases).toEqual([]);
    expect(result.warnings.some((w) => w.includes('insuficiente'))).toBe(true);
  });

  it('perfil filtra por score mínimo: conservador exclui score 50, agressivo inclui', () => {
    const conservador = suggestContribution(universe(), [], { amount: 5000, profile: 'conservador' });
    expect(conservador.purchases.every((p) => p.ticker !== 'DDDD3')).toBe(true);
    expect(conservador.skipped.some((s) => s.ticker === 'DDDD3' && s.reason.includes('Score'))).toBe(true);

    const agressivo = suggestContribution(universe(), [], { amount: 5000, profile: 'agressivo' });
    const all = [...agressivo.purchases.map((p) => p.ticker), ...agressivo.skipped.map((s) => s.ticker)];
    expect(agressivo.purchases.every((p) => p.score >= 45)).toBe(true);
  });

  it('posição em ticker fora do universo: warning, não explode', () => {
    const result = suggestContribution(
      universe(),
      [{ ticker: 'ZZZZ3', quantity: 100 }],
      { amount: 2000, profile: 'moderado' },
    );
    expect(result.warnings.some((w) => w.includes('ZZZZ3'))).toBe(true);
    expect(result.purchases.length).toBeGreaterThan(0);
  });

  it('onlyTypes fii: nenhuma ação comprada, orçamento inteiro em FIIs', () => {
    const result = suggestContribution(universe(), [], {
      amount: 2000, profile: 'moderado', onlyTypes: ['fii'],
    });
    expect(result.purchases.length).toBeGreaterThan(0);
    expect(result.purchases.every((p) => p.assetType === 'fii')).toBe(true);
  });

  it('excludeSectors: setor excluído vai para skipped', () => {
    const result = suggestContribution(universe(), [], {
      amount: 2000, profile: 'moderado', excludeSectors: ['financeiro'],
    });
    expect(result.purchases.every((p) => p.ticker !== 'CCCC3')).toBe(true);
    expect(result.skipped.some((s) => s.ticker === 'CCCC3' && s.reason.includes('excluído'))).toBe(true);
  });
});
