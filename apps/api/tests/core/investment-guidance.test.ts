import { describe, it, expect } from 'bun:test';
import { buildInvestmentGuidance } from '../../src/core/services/investment-guidance.ts';
import {
  buildFundamentusEnrichment,
  fillMissingFromFundamentus,
} from '../../src/core/services/fundamentus-enrichment.ts';
import type { FundamentusData } from '../../src/infra/services/scrapers/fundamentus-scraper.ts';

describe('buildInvestmentGuidance', () => {
  it('score alto e sem alertas → accumulate ou study_to_buy', () => {
    const g = buildInvestmentGuidance({
      ticker: 'WEGE3',
      assetType: 'stock',
      score: 78,
      reasons: ['ROE 28% — muito acima do setor', 'Baixíssimo endividamento'],
      alerts: [],
      dataCoveragePercent: 95,
      criticalComplete: true,
      anomalyCount: 0,
    });

    expect(['accumulate', 'study_to_buy']).toContain(g.stance);
    expect(g.stanceTone).toBe('positive');
    expect(g.ifNotHolding.length).toBeGreaterThan(20);
    expect(g.ifHolding.length).toBeGreaterThan(10);
    expect(g.nextSteps.length).toBeGreaterThanOrEqual(3);
    expect(g.why.some((w) => /ROE|Score/i.test(w))).toBe(true);
    expect(g.disclaimers.some((d) => /não é recomendação/i.test(d))).toBe(true);
    expect(g.structuredReasons.some((r) => r.kind === 'pro')).toBe(true);
  });

  it('score baixo → avoid_entry ou consider_reduce com riscos', () => {
    const g = buildInvestmentGuidance({
      ticker: 'WEAK3',
      assetType: 'stock',
      score: 28,
      reasons: [],
      alerts: ['Endividamento elevado', 'Prejuízo recorrente'],
      dataCoveragePercent: 80,
      criticalComplete: true,
    });

    expect(['avoid_entry', 'consider_reduce']).toContain(g.stance);
    expect(g.stanceTone).toBe('negative');
    expect(g.ifNotHolding.toLowerCase()).toMatch(/n[aã]o/);
    expect(g.risks.length).toBeGreaterThan(0);
    expect(g.structuredReasons.some((r) => r.kind === 'con')).toBe(true);
  });

  it('score intermediário → hold_watch', () => {
    const g = buildInvestmentGuidance({
      ticker: 'MIDL3',
      assetType: 'stock',
      score: 55,
      reasons: ['DY atrativo (5%)'],
      alerts: ['P/L elevado'],
      dataCoveragePercent: 70,
      criticalComplete: false,
    });

    expect(g.stance).toBe('hold_watch');
    expect(g.stanceTone).toBe('warning');
    expect(g.confidence).not.toBe('alta');
  });

  it('FII experimental sempre com disclaimer e confiança baixa', () => {
    const g = buildInvestmentGuidance({
      ticker: 'HGLG11',
      assetType: 'fii',
      score: 72,
      reasons: ['Renda estável'],
      alerts: [],
      qualityRating: 'bom',
      experimental: true,
      dataCoveragePercent: 90,
      criticalComplete: true,
    });

    expect(g.confidence).toBe('baixa');
    expect(g.disclaimers.some((d) => /experimental|FII/i.test(d))).toBe(true);
    expect(g.headline).toMatch(/experimental|HGLG11/i);
  });

  it('inclui divergências de fontes como info', () => {
    const g = buildInvestmentGuidance({
      ticker: 'PETR4',
      assetType: 'stock',
      score: 68,
      reasons: ['Earnings Yield alto'],
      alerts: [],
      sourceDivergences: ['P/L: interno 5 vs Fundamentus 8 (Δ 37%)'],
      dataCoveragePercent: 90,
      criticalComplete: true,
    });

    expect(g.structuredReasons.some((r) => r.kind === 'info' && /diverg/i.test(r.text))).toBe(true);
    expect(g.risks.some((r) => /diverg|CVM/i.test(r))).toBe(true);
  });
});

describe('fundamentus-enrichment', () => {
  const sampleFund = (): FundamentusData => ({
    ticker: 'PETR4',
    name: 'PETROBRAS',
    price: 40,
    pl: 5,
    pvp: 1.2,
    pebit: 3,
    psr: 1,
    evEbitda: 3,
    evEbit: 4,
    vpa: 30,
    lpa: 8,
    roe: 25,
    roic: 18,
    roa: 10,
    grossMargin: 45,
    ebitMargin: 35,
    netMargin: 20,
    cagrRevenue5y: 5,
    cagrEarnings5y: 8,
    grossDebtToEquity: 0.8,
    netDebtToEbitda: 1.5,
    netDebtToEquity: 0.7,
    totalAssets: 1e12,
    currentAssets: 1e11,
    cashAndEquivalents: 5e10,
    equity: 4e11,
    marketCap: 5e11,
    enterpriseValue: 8e11,
    avgDailyLiquidity: 1e9,
    freeFloat: 60,
    sharesOutstanding: 1e10,
    dy: 8,
    payout: 50,
    sector: 'Petróleo',
    subsector: 'Exploração',
    extractedAt: new Date().toISOString(),
  });

  it('detecta divergência forte de P/L', () => {
    const enr = buildFundamentusEnrichment(sampleFund(), {
      peRatio: 12,
      pbRatio: 1.2,
      roe: 25,
      dividendYield: 8,
      netMargin: 20,
      debtToEquity: 0.8,
      roic: 18,
    });

    expect(enr.available).toBe(true);
    expect(enr.divergences.some((d) => d.field === 'peRatio')).toBe(true);
    expect(enr.snapshot?.pl).toBe(5);
  });

  it('sem fund → available false', () => {
    const enr = buildFundamentusEnrichment(null, { peRatio: 10 });
    expect(enr.available).toBe(false);
    expect(enr.snapshot).toBeNull();
  });

  it('preenche só campos nulos do display', () => {
    const filled = fillMissingFromFundamentus(
      { peRatio: null as number | null, roe: 20 as number | null, pbRatio: undefined as number | undefined },
      sampleFund(),
    );
    expect(filled.peRatio as number).toBe(5);
    expect(filled.roe as number).toBe(20); // não sobrescreve
    expect(filled.pbRatio as number).toBe(1.2);
  });
});
