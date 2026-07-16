/**
 * StockScore — Score de ações 0-100 com 6 dimensões.
 *
 * Pilares: Valuation (28%), Rentabilidade (18%), Crescimento (15%),
 * Dividendos (14%), Qualidade (18%), Momento (7%).
 */

import type { FinancialIndicators } from '../entities/company-fundamentals.ts';
import type { MarketMomentum } from '../../infra/services/market-data-service.ts';

export interface StockScorePillar { score: number; weight: number; }

export interface StockScoreResult {
  ticker: string; companyName: string; score: number;
  breakdown: {
    valuation: StockScorePillar; profitability: StockScorePillar;
    growth: StockScorePillar; dividends: StockScorePillar;
    quality: StockScorePillar; momentum: StockScorePillar;
  };
  reasons: string[]; alerts: string[]; sector: string | null; diagnosis: string;
}

export interface HistoricalData { years: Array<{ fiscalYear: number; revenue: number; netIncome: number; roe: number; netMargin: number; debtToEquity: number; grossMargin: number; }>; }

// ─── Setores ────────────────────────────────────────────────────────────────

const SECTOR_DETAILS: Record<string, { defensive: boolean; avgPE: number; avgROE: number; avgGrossMargin: number; avgDebtToEquity: number }> = {
  'energia elétrica': { defensive: true, avgPE: 12, avgROE: 15, avgGrossMargin: 50, avgDebtToEquity: 1.0 },
  'saneamento': { defensive: true, avgPE: 12, avgROE: 12, avgGrossMargin: 45, avgDebtToEquity: 1.0 },
  'telecomunicações': { defensive: true, avgPE: 10, avgROE: 8, avgGrossMargin: 55, avgDebtToEquity: 1.0 },
  'saúde': { defensive: true, avgPE: 18, avgROE: 20, avgGrossMargin: 40, avgDebtToEquity: 0.8 },
  'alimentos': { defensive: true, avgPE: 15, avgROE: 15, avgGrossMargin: 30, avgDebtToEquity: 1.0 },
  'bebidas': { defensive: true, avgPE: 20, avgROE: 22, avgGrossMargin: 55, avgDebtToEquity: 0.5 },
  'financeiro': { defensive: false, avgPE: 8, avgROE: 15, avgGrossMargin: 60, avgDebtToEquity: 5.0 },
  'bens industriais': { defensive: false, avgPE: 25, avgROE: 18, avgGrossMargin: 35, avgDebtToEquity: 0.6 },
  'mineração': { defensive: false, avgPE: 6, avgROE: 20, avgGrossMargin: 40, avgDebtToEquity: 0.8 },
  'siderurgia': { defensive: false, avgPE: 8, avgROE: 12, avgGrossMargin: 25, avgDebtToEquity: 1.0 },
  'petróleo e gás': { defensive: false, avgPE: 6, avgROE: 15, avgGrossMargin: 45, avgDebtToEquity: 1.2 },
  'papel e celulose': { defensive: false, avgPE: 8, avgROE: 18, avgGrossMargin: 40, avgDebtToEquity: 1.5 },
  'transporte': { defensive: false, avgPE: 15, avgROE: 10, avgGrossMargin: 50, avgDebtToEquity: 2.0 },
  'construção': { defensive: false, avgPE: 10, avgROE: 10, avgGrossMargin: 30, avgDebtToEquity: 1.0 },
  'imobiliário': { defensive: false, avgPE: 12, avgROE: 8, avgGrossMargin: 60, avgDebtToEquity: 0.8 },
  'varejo': { defensive: false, avgPE: 15, avgROE: 12, avgGrossMargin: 35, avgDebtToEquity: 1.5 },
};

function getSectorDetail(s: string | null) { if (!s) return null; const sl = s.toLowerCase(); for (const [k, v] of Object.entries(SECTOR_DETAILS)) { if (sl.includes(k) || k.includes(sl)) return v; } return null; }

// ─── Calculator ──────────────────────────────────────────────────────────────

export class StockScoreCalculator {
  static calculate(ind: FinancialIndicators, sector: string | null, companyName: string, historical?: HistoricalData, momentum?: MarketMomentum): StockScoreResult {
    const reasons: string[] = [], alerts: string[] = [];
    const si = getSectorDetail(sector);

    const vs = this.scoreValuation(ind, si, reasons, alerts);
    const ps = this.scoreProfitability(ind, si, reasons, alerts);
    const gs = this.scoreGrowth(ind, historical, reasons, alerts);
    const ds = this.scoreDividends(ind, reasons, alerts);
    const qs = this.scoreQuality(ind, si, reasons, alerts);
    const ms = this.scoreMomentum(momentum, reasons, alerts);

    const score = Math.round(vs * 0.28 + ps * 0.18 + gs * 0.15 + ds * 0.14 + qs * 0.18 + ms * 0.07);
    const diagnosis = this.generateDiagnosis(score, reasons, alerts, sector);

    return { ticker: ind.ticker, companyName, score: Math.max(0, Math.min(100, score)),
      breakdown: { valuation: { score: vs, weight: 0.28 }, profitability: { score: ps, weight: 0.18 }, growth: { score: gs, weight: 0.15 }, dividends: { score: ds, weight: 0.14 }, quality: { score: qs, weight: 0.18 }, momentum: { score: ms, weight: 0.07 } },
      reasons, alerts, sector, diagnosis };
  }

  // ── Valuation: Earnings Yield vs SELIC + Quality Premium ────────────────

  private static scoreValuation(ind: FinancialIndicators, si: ReturnType<typeof getSectorDetail>, reasons: string[], alerts: string[]): number {
    if (ind.eps < 0) { alerts.push('Empresa com prejuízo'); return 10; }
    let total = 0, count = 0;
    const premium = this.hasQualityPremium(ind);

    if (ind.peRatio !== null && ind.peRatio > 0 && ind.peRatio < 200) {
      const ey = (1 / ind.peRatio) * 100, selic = 14.0; count++;
      if (ey >= selic) { total += 90; reasons.push(`Earnings Yield ${ey.toFixed(1)}% > SELIC — bate renda fixa`); }
      else if (ey >= selic * 0.7) { total += 65; }
      else if (ey >= selic * 0.4) { if (premium) { total += 55; reasons.push('P/L elevado mas justificado por ROE alto + baixo endividamento'); } else { total += 40; alerts.push(`Earnings Yield ${ey.toFixed(1)}% abaixo da SELIC`); } }
      else { if (premium) { total += 40; } else { total += 20; alerts.push(`Earnings Yield ${ey.toFixed(1)}% — renda fixa paga mais`); } }
    }
    if (ind.pbRatio !== null && ind.pbRatio > 0 && ind.pbRatio < 100) { count++;
      if (ind.pbRatio <= 1.0) { total += 85; reasons.push(`P/VP ${ind.pbRatio.toFixed(1)}x — desconto`); }
      else if (ind.pbRatio <= 2.0) total += 65; else if (ind.pbRatio <= 4.0) total += 45; else { if (premium) total += 40; else { total += 20; alerts.push(`P/VP alto (${ind.pbRatio.toFixed(1)}x)`); } }
    }
    if (ind.evEbit !== null && ind.evEbit > 0 && ind.evEbit < 100) { count++;
      const eey = (1 / ind.evEbit) * 100;
      if (eey >= 10) { total += 85; reasons.push(`EBIT/EV yield ${eey.toFixed(1)}%`); }
      else if (eey >= 6) total += 60; else if (eey >= 3) { if (premium) total += 45; else total += 35; }
      else { if (premium) total += 30; else { total += 20; alerts.push(`EBIT/EV yield baixo`); } }
    }
    return count === 0 ? 50 : Math.round(total / count);
  }

  private static hasQualityPremium(ind: FinancialIndicators): boolean {
    return [ind.roe !== null && ind.roe >= 15, ind.debtToEquity !== null && ind.debtToEquity <= 1.5, ind.fcoToNetIncome !== null && ind.fcoToNetIncome >= 0.5].filter(Boolean).length >= 2;
  }

  // ── Rentabilidade: ROE + Margens vs Setor ─────────────────────────────

  private static scoreProfitability(ind: FinancialIndicators, si: ReturnType<typeof getSectorDetail>, reasons: string[], alerts: string[]): number {
    let total = 0, count = 0;
    if (ind.roe !== null) { const sr = si?.avgROE ?? 12; count++;
      if (ind.roe >= sr * 1.5) { total += 90; reasons.push(`ROE ${ind.roe.toFixed(1)}% — muito acima do setor`); }
      else if (ind.roe >= sr) { total += 70; reasons.push(`ROE ${ind.roe.toFixed(1)}% — acima do setor`); }
      else if (ind.roe >= sr * 0.6) total += 45; else if (ind.roe > 0) { total += 25; alerts.push(`ROE baixo`); } else { total += 5; alerts.push('ROE negativo'); }
    }
    if (ind.grossMargin !== null) { const sg = si?.avgGrossMargin ?? 35; count++;
      if (ind.grossMargin >= sg * 1.3) { total += 85; reasons.push(`Margem bruta ${ind.grossMargin.toFixed(0)}% — poder de precificação`); }
      else if (ind.grossMargin >= sg) total += 65; else if (ind.grossMargin >= sg * 0.7) total += 40; else { total += 20; alerts.push(`Margem bruta baixa`); }
    }
    if (ind.netMargin !== null) { count++;
      if (ind.netMargin >= 15) { total += 85; reasons.push(`Margem líquida ${ind.netMargin.toFixed(1)}%`); }
      else if (ind.netMargin >= 8) total += 60; else if (ind.netMargin >= 3) total += 40; else if (ind.netMargin > 0) total += 25; else { total += 10; alerts.push('Margem líquida negativa'); }
    }
    return count === 0 ? 50 : Math.round(total / count);
  }

  // ── Crescimento: CAGR multi-ano ──────────────────────────────────────

  private static scoreGrowth(ind: FinancialIndicators, hist: HistoricalData | undefined, reasons: string[], alerts: string[]): number {
    if (!hist || hist.years.length < 2) { alerts.push('Poucos dados históricos'); return 40; }
    const sorted = [...hist.years].sort((a, b) => a.fiscalYear - b.fiscalYear);
    const oldest = sorted[0]!, newest = sorted[sorted.length - 1]!, ny = newest.fiscalYear - oldest.fiscalYear;
    if (ny < 1) return 45;
    let total = 0, count = 0;

    if (oldest.revenue > 0 && newest.revenue > 0) { count++;
      const cagr = (Math.pow(newest.revenue / oldest.revenue, 1 / ny) - 1) * 100;
      if (cagr >= 15) { total += 90; reasons.push(`Receita cresce ${cagr.toFixed(1)}%/ano`); }
      else if (cagr >= 8) { total += 75; reasons.push(`Receita cresce ${cagr.toFixed(1)}%/ano`); }
      else if (cagr >= 3) total += 55; else if (cagr >= 0) total += 35; else { total += 15; alerts.push(`Receita encolhendo`); }
    }
    if (oldest.netIncome > 0 && newest.netIncome > 0) { count++;
      const ecagr = (Math.pow(newest.netIncome / oldest.netIncome, 1 / ny) - 1) * 100;
      if (ecagr >= 15) { total += 90; reasons.push(`Lucro cresce ${ecagr.toFixed(1)}%/ano`); }
      else if (ecagr >= 8) total += 75; else if (ecagr >= 0) total += 50; else { total += 20; alerts.push('Lucro encolhendo'); }
    }
    if (sorted.length >= 3) { count++;
      const recent = sorted.slice(-3), older = sorted.slice(0, Math.min(3, sorted.length - 3));
      const rr = recent.reduce((s, y) => s + y.roe, 0) / recent.length;
      const or = older.length > 0 ? older.reduce((s, y) => s + y.roe, 0) / older.length : rr;
      const trend = rr - or;
      if (trend >= 5) { total += 90; reasons.push('ROE em forte melhora'); }
      else if (trend >= 2) total += 70; else if (trend >= -2) total += 50; else if (trend >= -5) { total += 30; alerts.push('ROE caindo'); } else { total += 15; alerts.push('ROE em colapso'); }
    }
    count++; const py = sorted.filter(y => y.netIncome > 0).length;
    if (py === sorted.length) { total += 90; reasons.push(`${sorted.length} anos consecutivos de lucro`); }
    else if (py / sorted.length >= 0.8) total += 65; else if (py / sorted.length >= 0.6) { total += 40; alerts.push('Histórico de lucros inconsistente'); } else { total += 20; alerts.push('Maioria dos anos com prejuízo'); }
    return Math.round(total / count);
  }

  // ── Dividendos ──────────────────────────────────────────────────────────

  private static scoreDividends(ind: FinancialIndicators, reasons: string[], alerts: string[]): number {
    if (ind.dividendYield === null) { alerts.push('DY indisponível'); return 30; }
    if (ind.dividendYield >= 8) { reasons.push(`DY alto (${ind.dividendYield.toFixed(1)}%)`); return 85; }
    if (ind.dividendYield >= 5) { reasons.push(`DY atrativo (${ind.dividendYield.toFixed(1)}%)`); return 75; }
    if (ind.dividendYield >= 3) return 60;
    if (ind.dividendYield >= 1) { alerts.push(`DY baixo`); return 40; }
    return 20;
  }

  // ── Qualidade: D/E, FCO, Setor ────────────────────────────────────────

  private static scoreQuality(ind: FinancialIndicators, si: ReturnType<typeof getSectorDetail>, reasons: string[], alerts: string[]): number {
    let total = 0, count = 0;
    if (ind.debtToEquity !== null) { const sd = si?.avgDebtToEquity ?? 1.0; count++;
      if (ind.debtToEquity <= 0.5) { total += 90; reasons.push('Baixíssimo endividamento'); }
      else if (ind.debtToEquity <= 1.0) { total += 75; reasons.push('Endividamento controlado'); }
      else if (ind.debtToEquity <= sd * 1.5) total += 50;
      else if (ind.debtToEquity <= sd * 2.5) { total += 30; alerts.push(`Endividamento elevado`); }
      else { total += 10; alerts.push('Endividamento crítico'); }
    }
    if (ind.fcoToNetIncome !== null) { count++;
      if (ind.fcoToNetIncome >= 1.0) { total += 85; reasons.push('Lucro de qualidade — FCO cobre lucro'); }
      else if (ind.fcoToNetIncome >= 0.7) total += 60; else if (ind.fcoToNetIncome > 0) { total += 35; alerts.push('Geração de caixa fraca'); } else { total += 15; alerts.push('FCO negativo'); }
    }
    if (si) { count++;
      if (si.defensive) { total += 80; reasons.push('Setor defensivo'); }
      else { total += 40; alerts.push('Setor cíclico'); }
    }
    return count === 0 ? 50 : Math.round(total / count);
  }

  // ── Momento ──────────────────────────────────────────────────────────

  private static scoreMomentum(mom: MarketMomentum | undefined, reasons: string[], alerts: string[]): number {
    if (!mom) { alerts.push('Dados de momento indisponíveis'); return 45; }
    let total = 0, count = 0;
    if (mom.return6m !== null) { count++;
      if (mom.return6m < -20) { total += 85; reasons.push(`Queda de ${Math.abs(mom.return6m)}% em 6M — possível oportunidade`); }
      else if (mom.return6m < 0) total += 60; else if (mom.return6m < 10) total += 50; else if (mom.return6m < 25) { total += 35; alerts.push(`Já subiu ${mom.return6m}% em 6M`); } else { total += 20; alerts.push(`Alta de ${mom.return6m}% em 6M — risco de correção`); }
    }
    if (mom.drawdownFrom52WeekHigh !== null) { count++;
      if (mom.drawdownFrom52WeekHigh >= 20) { total += 80; reasons.push(`-${mom.drawdownFrom52WeekHigh}% do topo`); }
      else if (mom.drawdownFrom52WeekHigh >= 10) total += 65; else if (mom.drawdownFrom52WeekHigh >= 0) total += 50; else { total += 25; alerts.push('No topo de 52 semanas'); }
    }
    if (mom.annualizedVolatility !== null) { count++;
      if (mom.annualizedVolatility < 20) total += 80; else if (mom.annualizedVolatility < 35) total += 55; else if (mom.annualizedVolatility < 50) { total += 35; alerts.push(`Volatilidade alta`); } else { total += 15; alerts.push('Volatilidade extrema'); }
    }
    return count === 0 ? 50 : Math.round(total / count);
  }

  // ── Diagnóstico ──────────────────────────────────────────────────────

  private static generateDiagnosis(score: number, reasons: string[], alerts: string[], _sector: string | null): string {
    if (score >= 75) return `${reasons.slice(0, 2).join('. ')}. Ação de alta qualidade.`;
    if (score >= 55) return `${reasons.slice(0, 1).join('')}. ${alerts.slice(0, 1).join('')}. Oportunidade com riscos.`;
    if (score >= 35) return `${alerts.slice(0, 2).join('. ')}. Exija desconto.`;
    return `${alerts.slice(0, 2).join('. ')}. Alto risco.`;
  }
}
