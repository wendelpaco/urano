/**
 * StockScore — Score de ações 0-100 com breakdown, reasons e alerts.
 *
 * Adaptado do AssetAnalyzer do easy-invest. Entrada: FinancialIndicators
 * (calculados de dados CVM auditados) + cotação Yahoo, em vez de snapshot
 * de scraper do StatusInvest.
 *
 * Pilares (pesos fixos na v1):
 * - Valuation 35%: P/L, P/VP, P/S
 * - Rentabilidade 25%: ROE, margem líquida
 * - Dividendos 20%: DY, payout
 * - Qualidade 25%: endividamento, setor defensivo, consistência
 */

import type { FinancialIndicators } from '../entities/company-fundamentals.ts';

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface StockScorePillar {
  score: number;   // 0-100
  weight: number;  // 0-1
}

export interface StockScoreResult {
  ticker: string;
  companyName: string;
  score: number;          // 0-100
  breakdown: {
    valuation: StockScorePillar;
    profitability: StockScorePillar;
    dividends: StockScorePillar;
    quality: StockScorePillar;
  };
  reasons: string[];
  alerts: string[];
  sector: string | null;
}

// ─── Setores defensivos ──────────────────────────────────────────────────────

const DEFENSIVE_SECTORS = new Set([
  'energia',
  'saneamento',
  'saúde',
  'alimentos',
  'bebidas',
  'seguros',
  'telecomunicações',
  'utilidade',
  'farmacêutico',
  'agropecuária',
]);

const CYCLICAL_SECTORS = new Set([
  'construção',
  'varejo',
  'aviação',
  'automóvel',
  'mineração',
  'siderurgia',
  'petróleo',
  'imobiliário',
  'hotéis',
  'entretenimento',
]);

// ─── Calculadora ─────────────────────────────────────────────────────────────

export class StockScoreCalculator {
  /**
   * Calcula o score de uma ação a partir de indicadores financeiros + preço.
   *
   * @param indicators FinancialIndicators (já com DY real da Onda 1d)
   * @param sector     Setor da empresa (para qualidade defensiva)
   * @param companyName Nome da empresa
   */
  static calculate(
    indicators: FinancialIndicators,
    sector: string | null,
    companyName: string,
  ): StockScoreResult {
    const reasons: string[] = [];
    const alerts: string[] = [];

    // ── Valuation (35%) ──────────────────────────────────────────────────
    const valuationScore = this.scoreValuation(indicators, reasons, alerts);

    // ── Rentabilidade (25%) ──────────────────────────────────────────────
    const profitabilityScore = this.scoreProfitability(indicators, reasons, alerts);

    // ── Dividendos (20%) ─────────────────────────────────────────────────
    const dividendsScore = this.scoreDividends(indicators, reasons, alerts);

    // ── Qualidade (20%) ──────────────────────────────────────────────────
    const qualityScore = this.scoreQuality(indicators, sector, reasons, alerts);

    // Score final ponderado
    const score = Math.round(
      valuationScore * 0.35 +
      profitabilityScore * 0.25 +
      dividendsScore * 0.20 +
      qualityScore * 0.20,
    );

    return {
      ticker: indicators.ticker,
      companyName,
      score: Math.max(0, Math.min(100, score)),
      breakdown: {
        valuation: { score: valuationScore, weight: 0.35 },
        profitability: { score: profitabilityScore, weight: 0.25 },
        dividends: { score: dividendsScore, weight: 0.20 },
        quality: { score: qualityScore, weight: 0.20 },
      },
      reasons,
      alerts,
      sector,
    };
  }

  // ── Valuation ──────────────────────────────────────────────────────────

  private static scoreValuation(
    ind: FinancialIndicators,
    reasons: string[],
    alerts: string[],
  ): number {
    let score = 50;
    let components = 0;
    let total = 0;

    // P/L
    if (ind.peRatio !== null && ind.peRatio > 0) {
      components++;
      if (ind.peRatio <= 8) {
        total += 90;
        reasons.push(`P/L baixo (${ind.peRatio.toFixed(1)}x) — boa relação preço/lucro`);
      } else if (ind.peRatio <= 15) {
        total += 70;
        reasons.push(`P/L razoável (${ind.peRatio.toFixed(1)}x)`);
      } else if (ind.peRatio <= 25) {
        total += 45;
        alerts.push(`P/L elevado (${ind.peRatio.toFixed(1)}x) — atenção ao preço`);
      } else {
        total += 20;
        alerts.push(`P/L muito elevado (${ind.peRatio.toFixed(1)}x) — ação possivelmente cara`);
      }
    }

    // P/VP
    if (ind.pbRatio !== null && ind.pbRatio > 0) {
      components++;
      if (ind.pbRatio <= 1.5) {
        total += 80;
        reasons.push(`P/VP atrativo (${ind.pbRatio.toFixed(2)}x)`);
      } else if (ind.pbRatio <= 3) {
        total += 60;
      } else if (ind.pbRatio <= 5) {
        total += 35;
      } else {
        total += 15;
        alerts.push(`P/VP muito alto (${ind.pbRatio.toFixed(2)}x)`);
      }
    }

    // P/S
    if (ind.psRatio !== null && ind.psRatio > 0) {
      components++;
      if (ind.psRatio <= 1) {
        total += 75;
      } else if (ind.psRatio <= 3) {
        total += 55;
      } else {
        total += 30;
      }
    }

    if (components === 0) return 50; // Neutro sem dados
    score = Math.round(total / components);

    // Ajuste: empresa com prejuízo → valuation péssimo
    if (ind.eps <= 0) {
      score = Math.min(score, 25);
      alerts.push('Empresa com prejuízo (EPS negativo)');
    }

    return Math.max(0, Math.min(100, score));
  }

  // ── Rentabilidade ──────────────────────────────────────────────────────

  private static scoreProfitability(
    ind: FinancialIndicators,
    reasons: string[],
    alerts: string[],
  ): number {
    let components = 0;
    let total = 0;

    // ROE
    if (ind.roe !== null) {
      components++;
      if (ind.roe >= 20) {
        total += 90;
        reasons.push(`ROE excelente (${ind.roe.toFixed(1)}%)`);
      } else if (ind.roe >= 15) {
        total += 75;
        reasons.push(`ROE bom (${ind.roe.toFixed(1)}%)`);
      } else if (ind.roe >= 10) {
        total += 55;
      } else if (ind.roe >= 5) {
        total += 35;
      } else if (ind.roe > 0) {
        total += 20;
        alerts.push(`ROE baixo (${ind.roe.toFixed(1)}%)`);
      } else {
        total += 10;
        alerts.push(`ROE negativo (${ind.roe.toFixed(1)}%) — empresa não gera retorno`);
      }
    }

    // Margem líquida
    if (ind.netMargin !== null) {
      components++;
      if (ind.netMargin >= 20) {
        total += 90;
        reasons.push(`Margem líquida excelente (${ind.netMargin.toFixed(1)}%)`);
      } else if (ind.netMargin >= 10) {
        total += 70;
      } else if (ind.netMargin >= 5) {
        total += 50;
      } else if (ind.netMargin > 0) {
        total += 30;
        alerts.push(`Margem líquida apertada (${ind.netMargin.toFixed(1)}%)`);
      } else {
        total += 10;
        alerts.push(`Margem líquida negativa (${ind.netMargin.toFixed(1)}%) — prejuízo`);
      }
    }

    if (components === 0) return 50;
    return Math.max(0, Math.min(100, Math.round(total / components)));
  }

  // ── Dividendos ─────────────────────────────────────────────────────────

  private static scoreDividends(
    ind: FinancialIndicators,
    reasons: string[],
    alerts: string[],
  ): number {
    if (ind.dividendYield === null) {
      alerts.push('Dividend Yield indisponível');
      return 30; // Penaliza falta de dados
    }

    let score = 50;

    if (ind.dividendYield >= 8) {
      score = 85;
      reasons.push(`DY alto (${ind.dividendYield.toFixed(1)}%)`);
    } else if (ind.dividendYield >= 5) {
      score = 75;
      reasons.push(`DY atrativo (${ind.dividendYield.toFixed(1)}%)`);
    } else if (ind.dividendYield >= 3) {
      score = 60;
    } else if (ind.dividendYield >= 1) {
      score = 40;
      alerts.push(`DY baixo (${ind.dividendYield.toFixed(1)}%)`);
    } else {
      score = 20;
      alerts.push(`DY insignificante (${ind.dividendYield.toFixed(1)}%)`);
    }

    return score;
  }

  // ── Qualidade ──────────────────────────────────────────────────────────

  private static scoreQuality(
    ind: FinancialIndicators,
    sector: string | null,
    reasons: string[],
    alerts: string[],
  ): number {
    let components = 0;
    let total = 0;

    // Endividamento (D/E)
    if (ind.debtToEquity !== null) {
      components++;
      if (ind.debtToEquity <= 0.5) {
        total += 85;
        reasons.push('Baixo endividamento');
      } else if (ind.debtToEquity <= 1) {
        total += 65;
      } else if (ind.debtToEquity <= 2) {
        total += 40;
        alerts.push(`Endividamento elevado (D/E ${ind.debtToEquity.toFixed(1)}x)`);
      } else {
        total += 15;
        alerts.push(`Endividamento crítico (D/E ${ind.debtToEquity.toFixed(1)}x)`);
      }
    }

    // FCO / Lucro Líquido (qualidade do lucro)
    if (ind.fcoToNetIncome !== null) {
      components++;
      if (ind.fcoToNetIncome >= 0.8) {
        total += 80;
      } else if (ind.fcoToNetIncome >= 0.5) {
        total += 60;
      } else if (ind.fcoToNetIncome > 0) {
        total += 40;
        alerts.push('Geração de caixa fraca em relação ao lucro');
      } else {
        total += 20;
        alerts.push('Fluxo de caixa operacional negativo');
      }
    }

    // Setor defensivo
    if (sector) {
      const s = sector.toLowerCase();
      if (DEFENSIVE_SECTORS.has(s)) {
        components++;
        total += 80;
        reasons.push(`Setor defensivo (${sector})`);
      } else if (CYCLICAL_SECTORS.has(s)) {
        components++;
        total += 35;
        alerts.push(`Setor cíclico (${sector}) — maior volatilidade`);
      }
    }

    if (components === 0) return 50;
    return Math.max(0, Math.min(100, Math.round(total / components)));
  }
}
