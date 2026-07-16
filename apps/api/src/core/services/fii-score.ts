/**
 * FII Scoring System V4.2 — CONTENCAO DE DADOS AUSENTES
 *
 * Portado de easy-invest. Lógica intocada, apenas imports ajustados ao layout do Urano:
 * core/services/ → lógica pura, core/data/ → datasets estáticos.
 *
 * CORREÇÕES V4.1 (OBRIGATÓRIAS):
 *
 * 1️⃣ CORREÇÃO CONCEITUAL - KNCR11
 *    - Reclassificado de high_yield para cdi_high_grade_juros_sensitive
 *    - DY normalizado: 8.5% - 10.5% (era 11.0% - 13.0%)
 *    - Limitador: risco_juros (era risco_credito)
 *    - Risco de crédito: baixo (era alto)
 *
 * 2️⃣ ENRIQUECIMENTO - SUBCLASSES DE TIJOLO
 *    - XPML11: shopping_prime_ciclico
 *    - RZTR11: logistica_defensiva
 *    - Influencia: risco_macro, risco_ciclo, explanation_short
 *    - Ajuste fino de score: +/-2 pontos máximo
 *
 * 3️⃣ AJUSTES NO RISK SCORE
 *    - cdi_high_grade_juros_sensitive: risco_credito BAIXO (85), risco_juros ALTO (30)
 *    - Peso maior em risco_juros para limitador
 *
 * 4️⃣ EXPLICAÇÕES ATUALIZADAS
 *    - KNCR11: "Fundo CRI high-grade e líquido, porém altamente sensível à queda do CDI."
 *    - XPML11: "Shopping prime bem localizado, porém exposto a ciclos de consumo."
 *    - RZTR11: "Logística defensiva com contratos longos, risco controlado."
 *
 * V4.2: dados criticos ausentes recebem pior caso + penalidade de cobertura;
 * o modelo nao imputa P/VP, liquidez, vacancia ou inadimplencia favoraveis.
 */

// ─── Imports (ajustados para layout Urano) ───────────────────────────────────

import { getFIIClassification } from '../data/fii-classification.data.ts';
import {
  aggregateMonthlyIncome,
  monthlyIncomeSeries,
} from './dividend-income.ts';
import {
  getPapelSubclass,
  normalizeDYBySubclass,
  type PapelSubclass,
} from '../data/fii-papel-subclasses.data.ts';
import {
  getTijoloSubclass,
  type TijoloSubclass,
  type TijoloSubclassification,
} from '../data/fii-tijolo-subclasses.data.ts';

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface IncomeQualityScoreV4 {
  score: number;
  stability: number;
  consistency: number;
  growth: number;
  sustainability: number;
  rating: 'excelente' | 'bom' | 'regular' | 'ruim';
}

export interface AssetQualityScoreV4 {
  score: number;
  valuation_score: number;
  p_vp: number | null;
  liquidity_score: number;
  rating: 'excelente' | 'bom' | 'regular' | 'ruim';
}

export interface RiskBreakdownV4 {
  credito: number | null;
  juros: number | null;
  vacancia: number | null;
  liquidez: number | null;
  estrutura: number | null;
}

export interface RiskScoreV4 {
  score: number;
  breakdown: RiskBreakdownV4;
  primary_risk: string;
  rating: 'baixo' | 'moderado' | 'alto' | 'critico';
}

export interface DYNormalizationV4 {
  dy_bruto: number;
  dy_normalizado: number;
  subclass: PapelSubclass | null;
  applied: boolean;
  reason: string;
}

export interface FIIScoreV4 {
  ticker: string;
  type: 'papel' | 'tijolo' | 'hibrido';
  subclasse_papel: PapelSubclass | null;
  subclasse_tijolo: TijoloSubclass | null;
  type_source: string;

  dy_normalization: DYNormalizationV4;

  income_quality: IncomeQualityScoreV4;
  asset_quality: AssetQualityScoreV4;
  risk: RiskScoreV4;

  overall_score: number;
  overall_rating: 'excelente' | 'bom' | 'regular' | 'ruim' | 'evitar';

  score_limiter: 'income' | 'asset' | 'risk';
  limiter_value: number;
  penalty_applied: number;
  missing_data_penalty: number;

  /**
   * Campo mantido por compatibilidade de contrato. O score FII ainda nao foi
   * validado ponto-no-tempo e, portanto, nao emite acao de investimento.
   */
  recommendation: {
    action: 'analise_experimental';
    conviction: 'baixa';
    principal_motivo: string;
    principal_risco: string;
  };

  explanation_short: string;

  metadata: {
    version: string;
    calculated_at: string;
    validation_status: 'experimental_not_validated';
    intended_use: 'experimental_screening_only';
    data_coverage: {
      percent: number;
      critical_complete: boolean;
      missing_fields: string[];
      policy: 'worst_case_plus_penalty';
    };
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Input simplificado (interface de entrada do Urano, com campos opcionais)
// ─────────────────────────────────────────────────────────────────────────────

export interface FIIScoreInput {
  ticker: string;
  price: number;
  dy: number;
  pvp: number | null;
  liquidity: number | null;
  dividendsHistory: Array<{ date: string; value: number; type: string }>;
  vacancy?: number;
  delinquency?: number;
  /** Data de corte da decisão; impede deslocar a janela para o último pagamento. */
  asOf?: string;
}

// ─── Scoring Logic (portado intocado) ────────────────────────────────────────

export class FIIScoreCalculatorV4 {
  static calculate(data: FIIScoreInput): FIIScoreV4 {
    const {
      ticker,
      price,
      dy,
      pvp: rawPvp,
      liquidity: rawLiquidity,
      dividendsHistory,
      vacancy: rawVacancy,
      delinquency: rawDelinquency,
      asOf: rawAsOf,
    } = data;
    const asOf = rawAsOf && /^\d{4}-\d{2}-\d{2}/.test(rawAsOf)
      ? rawAsOf.slice(0, 10)
      : new Date().toISOString().slice(0, 10);

    // Ausencia ou valor invalido permanece desconhecido. Nunca imputar um
    // numero favoravel (P/VP=1, vacancia=0 etc.) para compor a nota.
    const pvp = rawPvp !== null && Number.isFinite(rawPvp) && rawPvp > 0
      ? rawPvp
      : null;
    const liquidity = rawLiquidity !== null && Number.isFinite(rawLiquidity) && rawLiquidity > 0
      ? rawLiquidity
      : null;
    const vacancy = rawVacancy !== undefined && Number.isFinite(rawVacancy) && rawVacancy >= 0 && rawVacancy <= 100
      ? rawVacancy
      : null;
    const delinquency = rawDelinquency !== undefined && Number.isFinite(rawDelinquency) && rawDelinquency >= 0 && rawDelinquency <= 100
      ? rawDelinquency
      : null;

    // 1. Obter classificação
    const classification = getFIIClassification(ticker);
    const type = classification?.type || 'tijolo';
    const typeSource = classification?.source || 'inferred';

    const monthlyIncomeHistory = aggregateMonthlyIncome(dividendsHistory);
    const observedIncomeMonths = monthlyIncomeSeries(dividendsHistory, 12, asOf)
      .filter((event) => event.value > 0).length;

    const requiredData: Array<{ field: string; available: boolean }> = [
      { field: 'classification', available: typeSource !== 'inferred' },
      { field: 'pvp', available: pvp !== null },
      { field: 'liquidity', available: liquidity !== null },
      { field: 'dividends_history', available: observedIncomeMonths >= 6 },
    ];
    if (type !== 'papel') {
      requiredData.push(
        { field: 'vacancy', available: vacancy !== null },
        { field: 'delinquency', available: delinquency !== null },
      );
    }
    const missingFields = requiredData
      .filter((item) => !item.available)
      .map((item) => item.field);
    const coveragePercent = Math.round(
      ((requiredData.length - missingFields.length) / requiredData.length) * 100,
    );
    const missingDataPenalty = Math.min(25, missingFields.length * 5);

    // 1.1. V4.1: Obter subclasse de tijolo (se aplicável)
    const tijoloSubclassInfo = type === 'tijolo' ? getTijoloSubclass(ticker) : null;

    // 2. Normalizar DY com faixas dinâmicas (CORREÇÃO V4 #1)
    const dyNormalization = this.normalizeDYV4(ticker, dy, type);

    // 3. Calcular scores dimensionais
    const incomeQuality = this.calculateIncomeQuality(
      monthlyIncomeHistory,
      price,
      dyNormalization.dy_normalizado,
      asOf,
    );

    const assetQuality = this.calculateAssetQuality(pvp, liquidity);

    // 4. Calcular risk score com limitador distinto (CORREÇÃO V4 #2)
    const risk = this.calculateRiskScoreV4(type, dyNormalization, vacancy, delinquency, liquidity, ticker);

    // 5. Calcular overall score com penalização progressiva (CORREÇÃO V4 #3)
    const overallCalc = this.calculateOverallWithProgressivePenalty(
      incomeQuality.score,
      assetQuality.score,
      risk.score,
    );

    let overallScore = overallCalc.score;
    const scoreLimiter = overallCalc.limiter;
    const limiterValue = overallCalc.limiterValue;
    let penaltyApplied = overallCalc.penalty;

    // 5.1. V4.1: Aplicar ajuste fino para tijolos (+/-2 pts máximo)
    if (tijoloSubclassInfo && tijoloSubclassInfo.score_adjustment !== 0) {
      overallScore = Math.max(0, Math.min(100, overallScore + tijoloSubclassInfo.score_adjustment));
    }

    overallScore = Math.max(0, overallScore - missingDataPenalty);
    penaltyApplied += missingDataPenalty;

    // 6. Rating de qualidade. Sem acao de investimento ate validacao historica.
    const overallRating = this.getOverallRating(overallScore);
    const recommendation = this.getExperimentalAssessment(
      risk.primary_risk,
    );

    // 7. Explicação humana (CORREÇÃO V4 #4 + V4.1)
    const explanationShort = this.generateExplanation(
      type,
      dyNormalization.subclass,
      incomeQuality.score,
      risk.primary_risk,
      risk.score,
      overallScore,
      tijoloSubclassInfo ?? undefined,
    );

    return {
      ticker,
      type,
      subclasse_papel: dyNormalization.subclass,
      subclasse_tijolo: tijoloSubclassInfo?.subclass || null,
      type_source: typeSource,

      dy_normalization: dyNormalization,

      income_quality: incomeQuality,
      asset_quality: assetQuality,
      risk,

      overall_score: overallScore,
      overall_rating: overallRating,

      score_limiter: scoreLimiter,
      limiter_value: limiterValue,
      penalty_applied: penaltyApplied,
      missing_data_penalty: missingDataPenalty,

      recommendation,
      explanation_short: explanationShort,

      metadata: {
        version: 'v4.2',
        calculated_at: new Date().toISOString(),
        validation_status: 'experimental_not_validated',
        intended_use: 'experimental_screening_only',
        data_coverage: {
          percent: coveragePercent,
          critical_complete: missingFields.length === 0,
          missing_fields: missingFields,
          policy: 'worst_case_plus_penalty',
        },
      },
    };
  }

  // ── Métodos privados (idênticos ao easy-invest) ─────────────────────────

  private static normalizeDYV4(
    ticker: string,
    dyBruto: number,
    type: 'papel' | 'tijolo' | 'hibrido',
  ): DYNormalizationV4 {
    if (type !== 'papel') {
      return {
        dy_bruto: dyBruto,
        dy_normalizado: dyBruto,
        subclass: null,
        applied: false,
        reason: 'FII de tijolo - DY não normalizado',
      };
    }

    const result = normalizeDYBySubclass(ticker, dyBruto);

    return {
      dy_bruto: dyBruto,
      dy_normalizado: result.dy_normalizado,
      subclass: result.subclass,
      applied: result.applied,
      reason: result.reason,
    };
  }

  private static calculateIncomeQuality(
    history: Array<{ date: string; value: number; type: string }>,
    _currentPrice: number,
    dyNormalizado: number,
    asOf: string,
  ): IncomeQualityScoreV4 {
    const monthly = aggregateMonthlyIncome(history);
    const last12Months = monthlyIncomeSeries(monthly, 12, asOf);
    const paidMonths = last12Months.filter((event) => event.value > 0).length;
    if (paidMonths < 6) {
      return {
        score: 0,
        stability: 0,
        consistency: 0,
        growth: 0,
        sustainability: 0,
        rating: 'ruim',
      };
    }

    const values = last12Months.map((h) => h.value);

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance =
      values.reduce((sum, val) => sum + (val - mean) ** 2, 0) / values.length;
    const stdDev = Math.sqrt(variance);
    const cv = mean > 0 ? (stdDev / mean) * 100 : 100;

    let stability = 100 - cv * 2;
    stability = Math.max(0, Math.min(100, stability));

    const monthsWithoutPayment = 12 - paidMonths;
    let consistency = 100 - monthsWithoutPayment * 10;
    consistency = Math.max(0, Math.min(100, consistency));

    const recent6 = values.slice(0, 6);
    const previous6 = values.slice(6, 12);

    const recentAvg = recent6.reduce((a, b) => a + b, 0) / recent6.length;
    const previousAvg =
      previous6.length > 0
        ? previous6.reduce((a, b) => a + b, 0) / previous6.length
        : recentAvg;

    const growthRate =
      previousAvg > 0 ? ((recentAvg - previousAvg) / previousAvg) * 100 : 0;

    let growth = 50 + growthRate * 5;
    growth = Math.max(0, Math.min(100, growth));

    let sustainability = 50;
    if (dyNormalizado >= 10 && dyNormalizado <= 12) {
      sustainability = 90;
    } else if (dyNormalizado >= 8 && dyNormalizado < 10) {
      sustainability = 70;
    } else if (dyNormalizado >= 12 && dyNormalizado <= 14) {
      sustainability = 80;
    } else if (dyNormalizado > 14) {
      sustainability = 50;
    }

    const score = Math.round(
      stability * 0.35 + consistency * 0.25 + growth * 0.15 + sustainability * 0.25,
    );

    return {
      score,
      stability: Math.round(stability),
      consistency: Math.round(consistency),
      growth: Math.round(growth),
      sustainability: Math.round(sustainability),
      rating: this.getQualityRating(score),
    };
  }

  private static calculateAssetQuality(
    pvp: number | null,
    liquidity: number | null,
  ): AssetQualityScoreV4 {
    let valuationScore = 0;
    if (pvp === null) {
      valuationScore = 0;
    } else if (pvp < 0.85) {
      valuationScore = 95;
    } else if (pvp < 0.95) {
      valuationScore = 85;
    } else if (pvp <= 1.05) {
      valuationScore = 75;
    } else if (pvp <= 1.15) {
      valuationScore = 60;
    } else {
      valuationScore = 40;
    }

    let liquidityScore = 0;
    if (liquidity === null) {
      liquidityScore = 0;
    } else if (liquidity >= 2_000_000) {
      liquidityScore = 90;
    } else if (liquidity >= 1_000_000) {
      liquidityScore = 75;
    } else if (liquidity >= 500_000) {
      liquidityScore = 60;
    } else if (liquidity >= 200_000) {
      liquidityScore = 45;
    } else {
      liquidityScore = 30;
    }

    const score = Math.round(valuationScore * 0.6 + liquidityScore * 0.4);

    return {
      score,
      valuation_score: valuationScore,
      p_vp: pvp,
      liquidity_score: liquidityScore,
      rating: this.getQualityRating(score),
    };
  }

  private static calculateRiskScoreV4(
    type: 'papel' | 'tijolo' | 'hibrido',
    dyNormalization: DYNormalizationV4,
    vacancy: number | null,
    delinquency: number | null,
    liquidity: number | null,
    ticker: string,
  ): RiskScoreV4 {
    const breakdown: RiskBreakdownV4 = {
      credito: null,
      juros: null,
      vacancia: null,
      liquidez: null,
      estrutura: null,
    };

    let weightedSum = 0;
    let totalWeight = 0;
    let primaryRisk = '';

    if (type === 'papel') {
      const subclassInfo = getPapelSubclass(ticker);
      const subclass = dyNormalization.subclass;

      const dyNorm = dyNormalization.dy_normalizado;
      let creditoRisk = 50;

      if (subclass === 'high_grade') {
        creditoRisk = 85;
      } else if (subclass === 'cdi_high_grade_juros_sensitive') {
        creditoRisk = 85;
      } else if (subclass === 'middle_risk') {
        if (dyNorm >= 11.5) creditoRisk = 45;
        else if (dyNorm >= 10.5) creditoRisk = 55;
        else creditoRisk = 65;
      } else if (subclass === 'high_yield') {
        if (dyNorm >= 12.5) creditoRisk = 35;
        else if (dyNorm >= 11.5) creditoRisk = 45;
        else creditoRisk = 55;
      }

      breakdown.credito = creditoRisk;

      let jurosRisk = 50;

      if (subclass === 'high_grade') {
        jurosRisk = 35;
      } else if (subclass === 'cdi_high_grade_juros_sensitive') {
        jurosRisk = 30;
      } else if (subclass === 'middle_risk') {
        jurosRisk = 50;
      } else {
        jurosRisk = 60;
      }

      breakdown.juros = jurosRisk;

      let liquidezRisk = 0;
      if (liquidity === null) liquidezRisk = 0;
      else if (liquidity >= 2_000_000) liquidezRisk = 75;
      else if (liquidity >= 1_000_000) liquidezRisk = 65;
      else if (liquidity >= 500_000) liquidezRisk = 55;
      else if (liquidity >= 200_000) liquidezRisk = 45;
      else liquidezRisk = 35;

      breakdown.liquidez = liquidezRisk;

      if (subclassInfo?.limitador_esperado === 'risco_juros') {
        primaryRisk = 'Sensibilidade a variações da Selic/CDI';
        weightedSum = creditoRisk * 0.25 + jurosRisk * 0.5 + liquidezRisk * 0.25;
        totalWeight = 1.0;
      } else if (subclassInfo?.limitador_esperado === 'risco_credito') {
        primaryRisk = 'Risco de crédito e inadimplência';
        weightedSum = creditoRisk * 0.5 + jurosRisk * 0.25 + liquidezRisk * 0.25;
        totalWeight = 1.0;
      } else {
        primaryRisk = 'Risco de crédito';
        weightedSum = creditoRisk * 0.45 + jurosRisk * 0.3 + liquidezRisk * 0.25;
        totalWeight = 1.0;
      }
    } else {
      let vacanciaRisk = 0;
      if (vacancy === null) vacanciaRisk = 0;
      else if (vacancy < 3) vacanciaRisk = 95;
      else if (vacancy < 5) vacanciaRisk = 85;
      else if (vacancy < 8) vacanciaRisk = 70;
      else if (vacancy < 12) vacanciaRisk = 55;
      else if (vacancy < 18) vacanciaRisk = 40;
      else vacanciaRisk = 25;

      // Penalização por inadimplência (delinquency)
      if (vacancy !== null && delinquency === null) {
        // Pior penalizacao possivel do modelo: desconhecido nunca pontua acima
        // do mesmo fundo com inadimplencia observada.
        vacanciaRisk = Math.max(10, vacanciaRisk - 25);
      } else if (delinquency !== null && delinquency > 10) {
        vacanciaRisk = Math.max(10, vacanciaRisk - 25);
      } else if (delinquency !== null && delinquency > 5) {
        vacanciaRisk = Math.max(15, vacanciaRisk - 15);
      } else if (delinquency !== null && delinquency > 2) {
        vacanciaRisk = Math.max(25, vacanciaRisk - 5);
      }

      breakdown.vacancia = vacanciaRisk;
      breakdown.juros = 70;
      breakdown.estrutura = delinquency === null
        ? 0
        : delinquency > 0
          ? Math.max(0, 100 - delinquency * 5)
          : 100;

      let liquidezRisk = 0;
      if (liquidity === null) liquidezRisk = 0;
      else if (liquidity >= 5_000_000) liquidezRisk = 80;
      else if (liquidity >= 2_000_000) liquidezRisk = 70;
      else if (liquidity >= 1_000_000) liquidezRisk = 60;
      else if (liquidity >= 500_000) liquidezRisk = 50;
      else liquidezRisk = 40;

      breakdown.liquidez = liquidezRisk;

      primaryRisk = 'Risco de vacância e inadimplência de inquilinos';
      weightedSum = vacanciaRisk * 0.5 + (breakdown.juros ?? 50) * 0.25 + liquidezRisk * 0.25;
      totalWeight = 1.0;
    }

    const riskScore = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 50;

    return {
      score: riskScore,
      breakdown,
      primary_risk: primaryRisk,
      rating: this.getRiskRating(riskScore),
    };
  }

  private static calculateOverallWithProgressivePenalty(
    incomeScore: number,
    assetScore: number,
    riskScore: number,
  ): {
    score: number;
    limiter: 'income' | 'asset' | 'risk';
    limiterValue: number;
    penalty: number;
  } {
    const baseScore = Math.round(
      incomeScore * 0.4 + assetScore * 0.35 + riskScore * 0.25,
    );

    const scores = [
      { name: 'income' as const, value: incomeScore },
      { name: 'asset' as const, value: assetScore },
      { name: 'risk' as const, value: riskScore },
    ];
    scores.sort((a, b) => a.value - b.value);
    const limiter = scores[0]!;

    let penalty = 0;

    if (riskScore <= 60) {
      penalty = (60 - riskScore) * 0.5;
    } else if (riskScore <= 75) {
      penalty = 0;
    } else {
      penalty = 0;
    }

    if (limiter.value < 40) {
      penalty += 15;
    } else if (limiter.value < 50) {
      penalty += 8;
    } else if (limiter.value < 60) {
      penalty += 3;
    }

    const finalScore = Math.max(
      0,
      Math.min(100, Math.round(baseScore - penalty)),
    );

    return {
      score: finalScore,
      limiter: limiter.name,
      limiterValue: limiter.value,
      penalty: Math.round(penalty),
    };
  }

  private static generateExplanation(
    type: 'papel' | 'tijolo' | 'hibrido',
    subclass: PapelSubclass | null,
    incomeScore: number,
    _primaryRisk: string,
    _riskScore: number,
    _overallScore: number,
    tijoloSubclassInfo?: TijoloSubclassification,
  ): string {
    let pontoForte = '';
    let riscoDominante = '';

    if (incomeScore >= 90) {
      pontoForte = 'Excelente geração de renda com alta previsibilidade';
    } else if (incomeScore >= 75) {
      pontoForte = 'Boa geração de renda consistente';
    } else if (incomeScore >= 60) {
      pontoForte = 'Renda moderada com volatilidade controlada';
    } else {
      pontoForte = 'Renda instável com histórico irregular';
    }

    if (type === 'papel') {
      if (subclass === 'high_grade') {
        riscoDominante = 'alta sensibilidade a quedas do CDI/Selic';
      } else if (subclass === 'cdi_high_grade_juros_sensitive') {
        riscoDominante = 'altíssima sensibilidade à queda do CDI';
      } else if (subclass === 'middle_risk') {
        riscoDominante = 'risco moderado de crédito na carteira';
      } else if (subclass === 'high_yield') {
        riscoDominante = 'risco elevado de inadimplência';
      } else {
        riscoDominante = 'exposição a risco de crédito';
      }
    } else {
      if (tijoloSubclassInfo) {
        const subclassTijolo = tijoloSubclassInfo.subclass;

        if (subclassTijolo === 'shopping_prime_ciclico') {
          riscoDominante = 'exposição a ciclos de consumo';
        } else if (subclassTijolo === 'logistica_defensiva') {
          riscoDominante = 'risco controlado de vacância';
        } else if (subclassTijolo === 'lajes_corporativas_volatil') {
          riscoDominante = 'volatilidade de demanda corporativa';
        } else {
          riscoDominante = 'risco moderado de vacância';
        }
      } else {
        riscoDominante = 'risco moderado de vacância';
      }
    }

    return `${pontoForte}, porém com ${riscoDominante}.`;
  }

  private static getExperimentalAssessment(
    primaryRisk: string,
  ): {
    action: 'analise_experimental';
    conviction: 'baixa';
    principal_motivo: string;
    principal_risco: string;
  } {
    return {
      action: 'analise_experimental',
      conviction: 'baixa',
      principal_motivo:
        'Score experimental para triagem de qualidade; nao constitui recomendacao de investimento.',
      principal_risco: primaryRisk,
    };
  }

  private static getQualityRating(
    score: number,
  ): 'excelente' | 'bom' | 'regular' | 'ruim' {
    if (score >= 85) return 'excelente';
    if (score >= 70) return 'bom';
    if (score >= 55) return 'regular';
    return 'ruim';
  }

  private static getRiskRating(
    score: number,
  ): 'baixo' | 'moderado' | 'alto' | 'critico' {
    if (score >= 75) return 'baixo';
    if (score >= 60) return 'moderado';
    if (score >= 40) return 'alto';
    return 'critico';
  }

  private static getOverallRating(
    score: number,
  ): 'excelente' | 'bom' | 'regular' | 'ruim' | 'evitar' {
    if (score >= 85) return 'excelente';
    if (score >= 70) return 'bom';
    if (score >= 55) return 'regular';
    if (score >= 40) return 'ruim';
    return 'evitar';
  }
}
