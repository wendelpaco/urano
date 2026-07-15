/**
 * AllocationEngine — Motor de alocação de investimentos.
 *
 * Dado um perfil de risco e valor a investir, seleciona os melhores ativos
 * e distribui o capital com base em scores reais, preços reais (Yahoo),
 * fundamentos oficiais (CVM) e diversificação setorial.
 *
 * Diferente do easy-invest PortfolioBuilder (que usava estimativas falsas
 * de preço e dividendos), este motor usa dados concretos do Urano.
 */

import { db } from '../../infra/database/connection.ts';
import { sql } from 'drizzle-orm';
import { stockQuoteService } from '../../infra/services/stock-quote-service.ts';
import { dividendsProvider } from '../../infra/services/dividends-provider.ts';
import { redis } from '../../infra/services/redis.ts';
import { calcAllIndicators } from './indicators.ts';
import { StockScoreCalculator } from './stock-score.ts';
import {
  FIIScoreCalculatorV4,
  type FIIScoreInput,
} from './fii-score.ts';
import { RISK_CONFIGS, type RiskProfile } from '../data/risk-profiles.ts';

type AnalyzedAsset = {
  ticker: string;
  name: string;
  score: number;
  price: number;
  reasons: string[];
  alerts: string[];
  sector: string | null;
};

// ─── Tipos ───────────────────────────────────────────────────────────────────

export type { RiskProfile };

export interface AllocationConfig {
  totalAmount: number;
  riskProfile: RiskProfile;
  stockPercent: number;  // 0-100
  fiiPercent: number;     // 0-100 (deve somar 100 com stockPercent)
  minScore: number;       // score mínimo para inclusão
  maxAssets: number;      // máximo de ativos na carteira
}

export interface AllocatedAsset {
  ticker: string;
  name: string;
  assetType: 'stock' | 'fii';
  score: number;
  price: number;
  allocationPercent: number;
  allocationAmount: number;
  quantity: number;
  /** Motivos para incluir este ativo */
  reasons: string[];
  /** Riscos a considerar */
  alerts: string[];
}

export interface AllocationResult {
  config: AllocationConfig;
  assets: AllocatedAsset[];
  summary: {
    totalAssets: number;
    stocks: number;
    fiis: number;
    totalInvested: number;
    remainingCash: number;
    averageScore: number;
    estimatedAnnualDividend: number;
    estimatedMonthlyDividend: number;
    estimatedDividendYield: number;
  };
}

// ─── Motor ───────────────────────────────────────────────────────────────────

export class AllocationEngine {
  /**
   * Constrói uma carteira-modelo filtrada por score e perfil de risco.
   * O score é quality-filter (não preditor de retorno) — ver SCORE_VALIDATION.
   */
  async buildAllocation(
    config?: Partial<AllocationConfig>,
  ): Promise<AllocationResult> {
    const profile = config?.riskProfile ?? 'moderado';
    const profileConfig = RISK_CONFIGS[profile];

    const finalConfig: AllocationConfig = {
      totalAmount: config?.totalAmount ?? 10_000,
      riskProfile: profile,
      stockPercent: config?.stockPercent ?? profileConfig.stockPercent,
      fiiPercent: config?.fiiPercent ?? profileConfig.fiiPercent,
      minScore: config?.minScore ?? profileConfig.minScore,
      maxAssets: config?.maxAssets ?? profileConfig.maxAssets,
    };

    // Cache de resposta (mesmo perfil/valor) — evita re-scrape a cada clique
    const cacheKey =
      `allocation:${finalConfig.riskProfile}:${finalConfig.totalAmount}:` +
      `${finalConfig.minScore}:${finalConfig.maxAssets}:` +
      `${finalConfig.stockPercent}:${finalConfig.fiiPercent}`;
    try {
      const hit = await redis.get(cacheKey);
      if (hit) return JSON.parse(hit) as AllocationResult;
    } catch { /* redis offline */ }

    // Preferir scores do warmup (Redis) — O(1) por ativo, sem StatusInvest em lote.
    // Fallback: análise completa (lenta) só se cache vazio.
    let stocks = await this.loadCachedScores('stock');
    let fiis = await this.loadCachedScores('fii');
    if (stocks.length === 0) stocks = await this.analyzeAllStocks();
    if (fiis.length === 0) fiis = await this.analyzeAllFiis();

    // Filtra por score mínimo e ordena
    const eligibleStocks = stocks
      .filter((s) => s.score >= finalConfig.minScore && s.price > 0)
      .sort((a, b) => b.score - a.score);

    const eligibleFiis = fiis
      .filter((f) => f.score >= finalConfig.minScore && f.price > 0)
      .sort((a, b) => b.score - a.score);

    // Seleciona com diversificação setorial
    const stockBudget = (finalConfig.totalAmount * finalConfig.stockPercent) / 100;
    const fiiBudget = (finalConfig.totalAmount * finalConfig.fiiPercent) / 100;

    const maxStocks = Math.round(finalConfig.maxAssets * (finalConfig.stockPercent / 100));
    const maxFiis = finalConfig.maxAssets - maxStocks;

    // Candidatos extras: refresh de preço só nos finalistas (não nos 100+ do universo)
    const stockCandidates = this.selectDiversified(eligibleStocks, Math.max(maxStocks * 2, maxStocks));
    const fiiCandidates = this.selectDiversified(eligibleFiis, Math.max(maxFiis * 2, maxFiis));
    await this.refreshPrices(stockCandidates);
    await this.refreshPrices(fiiCandidates);

    const selectedStocks = this.selectDiversified(
      stockCandidates.filter((s) => s.price > 0),
      maxStocks,
    );
    const selectedFiis = this.selectDiversified(
      fiiCandidates.filter((f) => f.price > 0),
      maxFiis,
    );

    const allocatedStocks = this.allocateByScore(selectedStocks, stockBudget, 'stock');
    const allocatedFiis = this.allocateByScore(selectedFiis, fiiBudget, 'fii');

    const allAssets = [...allocatedStocks, ...allocatedFiis];

    const totalInvested = allAssets.reduce((s, a) => s + a.allocationAmount, 0);
    const avgScore = allAssets.length > 0
      ? allAssets.reduce((s, a) => s + a.score, 0) / allAssets.length
      : 0;

    const estimatedAnnualDividend = allAssets.reduce((sum, a) => {
      return sum + (a.allocationAmount * 0.06); // fallback 6% a.a.
    }, 0);

    const result: AllocationResult = {
      config: finalConfig,
      assets: allAssets,
      summary: {
        totalAssets: allAssets.length,
        stocks: allocatedStocks.length,
        fiis: allocatedFiis.length,
        totalInvested: Math.round(totalInvested * 100) / 100,
        remainingCash: Math.round((finalConfig.totalAmount - totalInvested) * 100) / 100,
        averageScore: Math.round(avgScore),
        estimatedAnnualDividend: Math.round(estimatedAnnualDividend * 100) / 100,
        estimatedMonthlyDividend: Math.round(estimatedAnnualDividend / 12 * 100) / 100,
        estimatedDividendYield: +(estimatedAnnualDividend / finalConfig.totalAmount * 100).toFixed(2),
      },
    };

    try {
      await redis.setex(cacheKey, 300, JSON.stringify(result));
    } catch { /* ok */ }

    return result;
  }

  /** Lê scores do warmup Redis (score:stock:* / score:fii:*). */
  private async loadCachedScores(type: 'stock' | 'fii'): Promise<AnalyzedAsset[]> {
    try {
      const keys = await redis.keys(`score:${type}:*`);
      if (keys.length === 0) return [];
      const out: AnalyzedAsset[] = [];
      for (const key of keys) {
        try {
          const raw = await redis.get(key);
          if (!raw) continue;
          const s = JSON.parse(raw) as {
            ticker: string;
            name: string;
            score: number;
            price: number;
          };
          if (!s.ticker || !(s.score > 0) || !(s.price > 0)) continue;
          out.push({
            ticker: s.ticker,
            name: s.name || s.ticker,
            score: s.score,
            price: s.price,
            reasons: ['Score de qualidade (cache warmup)'],
            alerts: [],
            sector: null,
          });
        } catch { /* skip */ }
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Atualiza preço só dos candidatos finais (poucos getQuote). */
  private async refreshPrices(assets: AnalyzedAsset[]): Promise<void> {
    for (const a of assets) {
      try {
        const q = await stockQuoteService.getQuote(a.ticker);
        if (q.price > 0) a.price = q.price;
      } catch {
        // mantém preço do cache
      }
    }
  }

  // ─── Análise ──────────────────────────────────────────────────────────

  async analyzeAllStocks(): Promise<Array<{
    ticker: string; name: string; score: number; price: number;
    reasons: string[]; alerts: string[]; sector: string | null;
  }>> {
    const rows = await db.execute(sql`
      SELECT DISTINCT ON (c.ticker)
        c.ticker, c.name, c.sector,
        cf.net_income_parent, cf.revenue, cf.cogs, cf.ebit,
        cf.total_assets, cf.total_liabilities, cf.cash,
        cf.operating_cash_flow, cf.equity, cf.shares_outstanding,
        cf.reference_date
      FROM companies c
      INNER JOIN company_fundamentals cf ON cf.company_cnpj = c.cnpj
      WHERE (c.ticker NOT LIKE '%11' OR c.ticker IN ('KLBN11','SANB11','TAEE11','ENGI11','ALUP11','BPAC11'))
        AND LENGTH(c.ticker) >= 5
      ORDER BY c.ticker, cf.source = 'DFP' DESC, cf.reference_date DESC
      LIMIT 100
    `);

    const results: Array<{
      ticker: string; name: string; score: number; price: number;
      reasons: string[]; alerts: string[]; sector: string | null;
    }> = [];

    for (const r of rows as unknown as Record<string, unknown>[]) {
      const ticker = String(r.ticker);
      let price = 0;
      try { const q = await stockQuoteService.getQuote(ticker); price = q.price; } catch { continue; }

      const indicators = calcAllIndicators(r, price);

      // Tenta buscar DY real
      try {
        const proventos = await dividendsProvider.fetchDividends(ticker);
        if (proventos && price > 0) {
          const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 12);
          const sum12m = proventos.filter((e) => e.date >= cutoff.toISOString().slice(0, 10))
            .reduce((s, e) => s + e.value, 0);
          if (sum12m > 0) indicators.dividendYield = +(sum12m / price * 100).toFixed(2);
        }
      } catch { /* sem proventos */ }

      const scoreResult = StockScoreCalculator.calculate(
        indicators,
        (r.sector as string) || null,
        String(r.name),
      );

      results.push({
        ticker, name: String(r.name), score: scoreResult.score, price,
        reasons: scoreResult.reasons, alerts: scoreResult.alerts,
        sector: (r.sector as string) || null,
      });
    }

    return results;
  }

  async analyzeAllFiis(): Promise<Array<{
    ticker: string; name: string; score: number; price: number;
    reasons: string[]; alerts: string[]; sector: string | null;
  }>> {
    const rows = await db.execute(sql`
      SELECT ticker, name, sector FROM companies
      WHERE ticker LIKE '%11' AND LENGTH(ticker) = 6 AND ticker NOT IN ('KLBN11','SANB11','TAEE11','ENGI11','ALUP11','BPAC11')
      ORDER BY ticker LIMIT 100
    `);

    const results: Array<{
      ticker: string; name: string; score: number; price: number;
      reasons: string[]; alerts: string[]; sector: string | null;
    }> = [];

    for (const r of rows as unknown as Record<string, unknown>[]) {
      const ticker = String(r.ticker);
      let price = 0;
      let liquidity: number | null = null;
      try {
        const q = await stockQuoteService.getQuote(ticker);
        price = q.price;
        liquidity = q.volume;
        if (price <= 0) continue;
      } catch { continue; }

      // Proventos + DY
      let dy = 0;
      let dividendEvents: Array<{ date: string; value: number; type: string }> = [];
      try {
        const proventos = await dividendsProvider.fetchDividends(ticker);
        if (proventos) {
          const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 12);
          dividendEvents = proventos.filter((e) => e.date >= cutoff.toISOString().slice(0, 10));
          const sum12m = dividendEvents.reduce((s, e) => s + e.value, 0);
          if (sum12m > 0) dy = +(sum12m / price * 100).toFixed(2);
        }
      } catch { /* ok */ }

      const input: FIIScoreInput = { ticker, price, dy, pvp: null, liquidity, dividendsHistory: dividendEvents };
      const scoreResult = FIIScoreCalculatorV4.calculate(input);

      results.push({
        ticker, name: String(r.name), score: scoreResult.overall_score, price,
        reasons: [scoreResult.explanation_short],
        alerts: scoreResult.risk.primary_risk ? [scoreResult.risk.primary_risk] : [],
        sector: scoreResult.subclasse_tijolo || scoreResult.subclasse_papel || null,
      });
    }

    return results;
  }

  // ─── Seleção e alocação ───────────────────────────────────────────────

  /**
   * Seleciona ativos com diversificação setorial.
   * Prioriza setores diferentes nos primeiros slots; se o setor for
   * desconhecido/null (ex.: cache warmup), preenche por score sem travar.
   */
  private selectDiversified<T extends { ticker: string; sector: string | null; score: number }>(
    assets: T[],
    maxAssets: number,
  ): T[] {
    if (maxAssets <= 0 || assets.length === 0) return [];

    const selected: T[] = [];
    const usedSectors = new Set<string>();
    const diversifySlots = Math.ceil(maxAssets * 0.6);

    // 1ª passagem: preferir setores novos
    for (const a of assets) {
      if (selected.length >= maxAssets) break;
      const sector = a.sector?.trim() || null;
      if (selected.length < diversifySlots && sector && usedSectors.has(sector)) {
        continue;
      }
      selected.push(a);
      if (sector) usedSectors.add(sector);
    }

    // 2ª passagem: completar vagas só por score (evita carteira com 1 ativo quando sector=null)
    if (selected.length < maxAssets) {
      const taken = new Set(selected.map((s) => s.ticker));
      for (const a of assets) {
        if (selected.length >= maxAssets) break;
        if (taken.has(a.ticker)) continue;
        selected.push(a);
      }
    }

    return selected;
  }

  /**
   * Distribui o orçamento proporcionalmente ao score de cada ativo.
   */
  private allocateByScore<T extends { ticker: string; name: string; score: number; price: number; reasons: string[]; alerts: string[] }>(
    assets: T[],
    budget: number,
    assetType: 'stock' | 'fii',
  ): AllocatedAsset[] {
    if (assets.length === 0) return [];

    const totalScore = assets.reduce((s, a) => s + a.score, 0);

    return assets.map((a) => {
      const weight = a.score / totalScore;
      const allocPct = weight * 100;
      const allocAmount = budget * weight;
      const qty = a.price > 0 ? Math.floor(allocAmount / a.price) : 0;

      return {
        ticker: a.ticker,
        name: a.name,
        assetType,
        score: a.score,
        price: a.price,
        allocationPercent: Math.round(allocPct * 10) / 10,
        allocationAmount: Math.round(allocAmount * 100) / 100,
        quantity: qty,
        reasons: a.reasons,
        alerts: a.alerts,
      };
    });
  }
}
