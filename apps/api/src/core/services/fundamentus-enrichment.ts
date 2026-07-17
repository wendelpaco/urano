/**
 * Fundamentus enrichment — cross-check e preenchimento complementar.
 *
 * CVM continua a fonte de verdade do score de ações. Fundamentus entra para:
 *  1) Preencher indicadores ausentes no response (UX densa)
 *  2) Flag de divergência quando CVM e Fundamentus discordam demais
 *
 * Pure compare helpers + thin async fetch wrapper.
 */

import type { FundamentusData } from '../../infra/services/scrapers/fundamentus-scraper.ts';

export interface IndicatorSnapshot {
  peRatio?: number | null;
  pbRatio?: number | null;
  roe?: number | null;
  dividendYield?: number | null;
  netMargin?: number | null;
  debtToEquity?: number | null;
  roic?: number | null;
  psRatio?: number | null;
  evEbit?: number | null;
}

export interface MetricDivergence {
  field: string;
  cvmOrInternal: number;
  fundamentus: number;
  /** Diferença relativa em % (abs). */
  relDiffPct: number;
  message: string;
}

export interface FundamentusEnrichment {
  available: boolean;
  source: 'fundamentus';
  extractedAt: string | null;
  /** Snapshot amigável para a ficha do ativo. */
  snapshot: {
    price: number | null;
    pl: number | null;
    pvp: number | null;
    psr: number | null;
    evEbit: number | null;
    evEbitda: number | null;
    roe: number | null;
    roic: number | null;
    roa: number | null;
    grossMargin: number | null;
    ebitMargin: number | null;
    netMargin: number | null;
    dy: number | null;
    grossDebtToEquity: number | null;
    netDebtToEquity: number | null;
    marketCap: number | null;
    enterpriseValue: number | null;
    avgDailyLiquidity: number | null;
    freeFloat: number | null;
    cagrRevenue5y: number | null;
    cagrEarnings5y: number | null;
    sector: string | null;
    subsector: string | null;
    lpa: number | null;
    vpa: number | null;
  } | null;
  divergences: MetricDivergence[];
  /** Mensagens curtas para guidance / UI. */
  divergenceMessages: string[];
}

const REL_THRESHOLD = 0.35; // 35% de divergência relativa
const ABS_FLOOR: Record<string, number> = {
  peRatio: 2,
  pbRatio: 0.3,
  roe: 3,
  dividendYield: 1,
  netMargin: 3,
  debtToEquity: 0.25,
  roic: 3,
};

/**
 * Compara indicadores internos (CVM-calc) com Fundamentus e monta enrichment.
 */
export function buildFundamentusEnrichment(
  fund: FundamentusData | null,
  internal: IndicatorSnapshot,
): FundamentusEnrichment {
  if (!fund) {
    return {
      available: false,
      source: 'fundamentus',
      extractedAt: null,
      snapshot: null,
      divergences: [],
      divergenceMessages: [],
    };
  }

  const divergences: MetricDivergence[] = [];

  pushDiv(divergences, 'P/L', 'peRatio', internal.peRatio, fund.pl);
  pushDiv(divergences, 'P/VP', 'pbRatio', internal.pbRatio, fund.pvp);
  pushDiv(divergences, 'ROE', 'roe', internal.roe, fund.roe);
  pushDiv(divergences, 'DY', 'dividendYield', internal.dividendYield, fund.dy);
  pushDiv(divergences, 'Margem líquida', 'netMargin', internal.netMargin, fund.netMargin);
  pushDiv(divergences, 'Dív/PL', 'debtToEquity', internal.debtToEquity, fund.grossDebtToEquity);
  pushDiv(divergences, 'ROIC', 'roic', internal.roic, fund.roic);

  return {
    available: true,
    source: 'fundamentus',
    extractedAt: fund.extractedAt,
    snapshot: {
      price: nz(fund.price),
      pl: nz(fund.pl),
      pvp: nz(fund.pvp),
      psr: nz(fund.psr),
      evEbit: nz(fund.evEbit),
      evEbitda: nz(fund.evEbitda),
      roe: nz(fund.roe),
      roic: nz(fund.roic),
      roa: nz(fund.roa),
      grossMargin: nz(fund.grossMargin),
      ebitMargin: nz(fund.ebitMargin),
      netMargin: nz(fund.netMargin),
      dy: nz(fund.dy),
      grossDebtToEquity: nz(fund.grossDebtToEquity),
      netDebtToEquity: nz(fund.netDebtToEquity),
      marketCap: nz(fund.marketCap),
      enterpriseValue: nz(fund.enterpriseValue),
      avgDailyLiquidity: nz(fund.avgDailyLiquidity),
      freeFloat: fund.freeFloat,
      cagrRevenue5y: fund.cagrRevenue5y,
      cagrEarnings5y: fund.cagrEarnings5y,
      sector: fund.sector || null,
      subsector: fund.subsector || null,
      lpa: nz(fund.lpa),
      vpa: nz(fund.vpa),
    },
    divergences,
    divergenceMessages: divergences.map((d) => d.message),
  };
}

/**
 * Preenche campos nulos do snapshot interno com valores Fundamentus (só display).
 * Não altera inputs do score.
 */
export function fillMissingFromFundamentus<T extends Record<string, unknown>>(
  indicators: T,
  fund: FundamentusData | null,
): T {
  if (!fund) return indicators;
  const out = { ...indicators };

  const fill = (key: string, value: number | null | undefined) => {
    const cur = out[key];
    if ((cur === null || cur === undefined) && value != null && Number.isFinite(value) && value !== 0) {
      (out as Record<string, unknown>)[key] = value;
    }
  };

  fill('peRatio', fund.pl);
  fill('pbRatio', fund.pvp);
  fill('psRatio', fund.psr);
  fill('pebit', fund.pebit);
  fill('evEbit', fund.evEbit);
  fill('roe', fund.roe);
  fill('roic', fund.roic);
  fill('roa', fund.roa);
  fill('grossMargin', fund.grossMargin);
  fill('ebitMargin', fund.ebitMargin);
  fill('netMargin', fund.netMargin);
  fill('dividendYield', fund.dy);
  fill('debtToEquity', fund.grossDebtToEquity);
  fill('netDebtToEquity', fund.netDebtToEquity);
  fill('marketCap', fund.marketCap);
  fill('eps', fund.lpa);
  fill('bvps', fund.vpa);

  return out;
}

function pushDiv(
  list: MetricDivergence[],
  label: string,
  field: string,
  a: number | null | undefined,
  b: number | null | undefined,
): void {
  if (a == null || b == null) return;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return;
  // Sinais opostos (ex.: ROE + vs −) = divergência forte
  if (a !== 0 && b !== 0 && Math.sign(a) !== Math.sign(b)) {
    list.push({
      field,
      cvmOrInternal: a,
      fundamentus: b,
      relDiffPct: 100,
      message: `${label}: interno ${fmt(a)} vs Fundamentus ${fmt(b)} (sinais opostos)`,
    });
    return;
  }
  const base = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  const rel = Math.abs(a - b) / base;
  const floor = ABS_FLOOR[field] ?? 0;
  if (Math.abs(a - b) < floor) return;
  if (rel < REL_THRESHOLD) return;
  list.push({
    field,
    cvmOrInternal: a,
    fundamentus: b,
    relDiffPct: +(rel * 100).toFixed(1),
    message: `${label}: interno ${fmt(a)} vs Fundamentus ${fmt(b)} (Δ ${+(rel * 100).toFixed(0)}%)`,
  });
}

function nz(n: number): number | null {
  if (!Number.isFinite(n) || n === 0) return n === 0 ? 0 : null;
  return n;
}

function fmt(n: number): string {
  if (Math.abs(n) >= 100) return n.toFixed(0);
  if (Math.abs(n) >= 10) return n.toFixed(1);
  return n.toFixed(2);
}
