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
import { companies, companyFundamentals } from '../../infra/database/schema.ts';
import { eq, desc, sql } from 'drizzle-orm';
import { stockQuoteService } from '../../infra/services/stock-quote-service.ts';
import { dividendsProvider } from '../../infra/services/dividends-provider.ts';
import { calcAllIndicators } from './indicators.ts';
import { StockScoreCalculator } from './stock-score.ts';
import {
  FIIScoreCalculatorV4,
  type FIIScoreInput,
} from './fii-score.ts';

// ─── Tipos ───────────────────────────────────────────────────────────────────

export type RiskProfile = 'conservador' | 'moderado' | 'agressivo';

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

// ─── Perfis de risco → configurações ─────────────────────────────────────────

const RISK_CONFIGS: Record<RiskProfile, { stockPercent: number; fiiPercent: number; minScore: number; maxAssets: number }> = {
  conservador: {
    stockPercent: 30,
    fiiPercent: 70,
    minScore: 65,
    maxAssets: 5,
  },
  moderado: {
    stockPercent: 50,
    fiiPercent: 50,
    minScore: 55,
    maxAssets: 8,
  },
  agressivo: {
    stockPercent: 70,
    fiiPercent: 30,
    minScore: 45,
    maxAssets: 12,
  },
};

// ─── Motor ───────────────────────────────────────────────────────────────────

export class AllocationEngine {
  /**
   * Constrói uma carteira recomendada com base no perfil de risco.
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

    // 1. Analisa todas as ações com fundamentals no banco
    const stocks = await this.analyzeAllStocks();

    // 2. Analisa todos os FIIs cadastrados
    const fiis = await this.analyzeAllFiis();

    // 3. Filtra por score mínimo e ordena
    const eligibleStocks = stocks
      .filter((s) => s.score >= finalConfig.minScore)
      .sort((a, b) => b.score - a.score);

    const eligibleFiis = fiis
      .filter((f) => f.score >= finalConfig.minScore)
      .sort((a, b) => b.score - a.score);

    // 4. Seleciona com diversificação setorial
    const stockBudget = (finalConfig.totalAmount * finalConfig.stockPercent) / 100;
    const fiiBudget = (finalConfig.totalAmount * finalConfig.fiiPercent) / 100;

    const maxStocks = Math.round(finalConfig.maxAssets * (finalConfig.stockPercent / 100));
    const maxFiis = finalConfig.maxAssets - maxStocks;

    const selectedStocks = this.selectDiversified(eligibleStocks, maxStocks);
    const selectedFiis = this.selectDiversified(eligibleFiis, maxFiis);

    // 5. Aloca proporcionalmente por score
    const allocatedStocks = this.allocateByScore(selectedStocks, stockBudget, 'stock');
    const allocatedFiis = this.allocateByScore(selectedFiis, fiiBudget, 'fii');

    const allAssets = [...allocatedStocks, ...allocatedFiis];

    // 6. Calcula resumo
    const totalInvested = allAssets.reduce((s, a) => s + a.allocationAmount, 0);
    const avgScore = allAssets.length > 0
      ? allAssets.reduce((s, a) => s + a.score, 0) / allAssets.length
      : 0;

    // Estima dividendos com base nos DY reais dos ativos selecionados
    const estimatedAnnualDividend = allAssets.reduce((sum, a) => {
      // Busca DY do item (se disponível nos reasons/alerts)
      const dyMatch = a.reasons
        .concat(a.alerts)
        .find((r) => r.includes('DY'))
        ?.match(/[\d.]+/);
      return sum + (a.allocationAmount * 0.06); // fallback 6% a.a.
    }, 0);

    return {
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
        estimatedDividendYield:+(estimatedAnnualDividend / finalConfig.totalAmount * 100).toFixed(2),
      },
    };
  }

  // ─── Análise ──────────────────────────────────────────────────────────

  private async analyzeAllStocks(): Promise<Array<{
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
      WHERE c.ticker NOT LIKE '%11'
        AND LENGTH(c.ticker) >= 5
      ORDER BY c.ticker, cf.reference_date DESC
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

  private async analyzeAllFiis(): Promise<Array<{
    ticker: string; name: string; score: number; price: number;
    reasons: string[]; alerts: string[]; sector: string | null;
  }>> {
    const rows = await db.execute(sql`
      SELECT ticker, name, sector FROM companies
      WHERE ticker LIKE '%11' AND LENGTH(ticker) = 6
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
   * Prioriza setores diferentes para os primeiros 60% das vagas.
   */
  private selectDiversified<T extends { ticker: string; sector: string | null; score: number }>(
    assets: T[],
    maxAssets: number,
  ): T[] {
    const selected: T[] = [];
    const usedSectors = new Set<string>();

    const diversifySlots = Math.ceil(maxAssets * 0.6);

    for (const a of assets) {
      if (selected.length >= maxAssets) break;
      const sector = a.sector || 'outros';

      if (selected.length < diversifySlots) {
        if (!usedSectors.has(sector)) {
          selected.push(a);
          usedSectors.add(sector);
        }
      } else {
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
