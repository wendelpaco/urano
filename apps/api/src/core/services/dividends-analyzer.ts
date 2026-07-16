/**
 * DividendsAnalyzer — Análise de proventos (dividendos, JCP, rendimentos FII).
 *
 * Portado de easy-invest. Classe estática, zero dependências de I/O.
 * Opera sobre Array<{ date, value, type }> e retorna métricas de qualidade.
 */

import { aggregateMonthlyIncome } from './dividend-income.ts';

export interface DividendEvent {
  date: string;   // "YYYY-MM-DD"
  value: number;  // valor por cota
  type: string;   // "DIVIDEND" | "JCP" | "RENDIMENTO" | "AMORTIZACAO"
}

export interface DividendAnalysis {
  /** 0-1, quanto mais próximo de 1 mais estável o valor (1 - CV) */
  stability: number;
  /** 0-1, regularidade de pagamentos (meses com evento / total de meses no período) */
  consistency: number;
  /** -1 a 1, tendência: valor médio dos últimos 6 meses vs 6 meses anteriores */
  trend: number;
  /** 0-100, score composto ponderado */
  quality: number;
  /** Período analisado */
  period: { start: string; end: string };
  /** Quantidade de eventos */
  totalEvents: number;
  /** Média mensal dos últimos 12 meses */
  averageMonthly: number;
  /** Soma dos últimos 12 meses */
  sum12m: number;
}

/**
 * Analisa um array de eventos de proventos e retorna métricas de qualidade.
 *
 * Pesos do score:
 * - Estabilidade (CV): 40%
 * - Consistência: 35%
 * - Tendência: 25%
 */
export class DividendsAnalyzer {
  /**
   * Analisa a qualidade do histórico de proventos.
   *
   * @param events Eventos de proventos (ordenados por data, mais recente primeiro ou não — será ordenado internamente)
   * @param lookbackMonths Janela de análise em meses (default 24)
   * @returns DividendAnalysis ou null se não há eventos
   */
  static analyze(
    events: DividendEvent[],
    lookbackMonths: number = 24,
  ): DividendAnalysis | null {
    if (!events || events.length === 0) return null;

    // Renda exclui devolucao de principal e consolida todos os eventos da
    // mesma competencia antes de medir estabilidade e tendencia.
    const monthlyIncome = aggregateMonthlyIncome(events);
    if (monthlyIncome.length === 0) return null;

    // Ordena cronologicamente
    const sorted = [...monthlyIncome].sort(
      (a, b) => a.date.localeCompare(b.date),
    );

    const firstDate = sorted[0]!.date;
    const lastDate = sorted[sorted.length - 1]!.date;

    // Corta para a janela de análise
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - lookbackMonths);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const filtered = sorted.filter((e) => e.date >= cutoffStr);

    if (filtered.length === 0) {
      // Sem eventos na janela — tenta com todos
      return this.calculateMetrics(sorted, firstDate, lastDate);
    }

    return this.calculateMetrics(
      filtered,
      filtered[0]!.date,
      filtered[filtered.length - 1]!.date,
    );
  }

  // ---------------------------------------------------------------------------
  // Privados
  // ---------------------------------------------------------------------------

  private static calculateMetrics(
    events: DividendEvent[],
    periodStart: string,
    periodEnd: string,
  ): DividendAnalysis {
    const values = events.map((e) => e.value);

    // Estabilidade: 1 - coeficiente de variação
    const stability = this.calculateStability(values);

    // Consistência: proporção de meses com pagamento
    const consistency = this.calculateConsistency(events, periodStart, periodEnd);

    // Tendência: 6 meses recentes vs 6 anteriores
    const trend = this.calculateTrend(events);

    // Soma 12m
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
    const cutoff12m = twelveMonthsAgo.toISOString().slice(0, 10);

    const recent12m = events.filter((e) => e.date >= cutoff12m);
    const sum12m = recent12m.reduce((sum, e) => sum + e.value, 0);

    const avgMonthly =
      recent12m.length > 0
        ? sum12m / Math.min(12, this.monthsBetween(cutoff12m, periodEnd))
        : 0;

    // Score composto 0-100
    const quality = Math.round(
      (stability * 40 + consistency * 35 + ((trend + 1) / 2) * 25),
    );

    return {
      stability: Math.round(stability * 10_000) / 10_000,
      consistency: Math.round(consistency * 10_000) / 10_000,
      trend: Math.round(trend * 10_000) / 10_000,
      quality: Math.max(0, Math.min(100, quality)),
      period: { start: periodStart, end: periodEnd },
      totalEvents: events.length,
      averageMonthly: Math.round(avgMonthly * 100) / 100,
      sum12m: Math.round(sum12m * 100) / 100,
    };
  }

  /**
   * Estabilidade baseada no coeficiente de variação (CV).
   * stability = max(0, 1 - CV)
   * CV = desvio padrão / média
   *
   * Valores altos e constantes → CV baixo → estabilidade alta
   * Valores com grandes oscilações → CV alto → estabilidade baixa
   */
  private static calculateStability(values: number[]): number {
    if (values.length < 2) return 0.5; // Neutro com 1 único dado

    const n = values.length;
    const mean = values.reduce((a, b) => a + b, 0) / n;

    if (mean === 0) return 0;

    const variance =
      values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n;
    const stdDev = Math.sqrt(variance);
    const cv = stdDev / Math.abs(mean);

    // CV > 1 → estabilidade 0 (variação maior que a média)
    return Math.max(0, Math.min(1, 1 - cv));
  }

  /**
   * Consistência: proporção de meses com pelo menos 1 evento de provento.
   * FIIs mensais → consistência alta (próximo de 1)
   * Empresas com pagamento esporádico → consistência baixa
   */
  private static calculateConsistency(
    events: DividendEvent[],
    periodStart: string,
    periodEnd: string,
  ): number {
    const monthsWithEvents = new Set<string>();
    for (const e of events) {
      monthsWithEvents.add(e.date.slice(0, 7)); // "YYYY-MM"
    }

    const totalMonths = this.monthsBetween(periodStart, periodEnd);
    if (totalMonths === 0) return events.length > 0 ? 1 : 0;

    return Math.min(1, monthsWithEvents.size / totalMonths);
  }

  /**
   * Tendência: compara média dos últimos 6 meses com os 6 meses anteriores.
   * Usa a data do evento mais recente como referência.
   *
   * Retorna -1 a 1:
   * - Próximo de 1: crescimento forte
   * - Próximo de 0: estável
   * - Próximo de -1: queda forte
   */
  private static calculateTrend(events: DividendEvent[]): number {
    if (events.length < 2) return 0;

    const lastDate = events[events.length - 1]!.date;
    const refDate = new Date(lastDate);

    // Últimos 6 meses
    const cutoffRecent = new Date(refDate);
    cutoffRecent.setMonth(cutoffRecent.getMonth() - 6);
    const recentStr = cutoffRecent.toISOString().slice(0, 10);

    // 6 meses anteriores a estes
    const cutoffPrevious = new Date(cutoffRecent);
    cutoffPrevious.setMonth(cutoffPrevious.getMonth() - 6);
    const previousStr = cutoffPrevious.toISOString().slice(0, 10);

    const recent = events.filter(
      (e) => e.date >= recentStr && e.date <= lastDate,
    );
    const previous = events.filter(
      (e) => e.date >= previousStr && e.date < recentStr,
    );

    const avgRecent =
      recent.length > 0
        ? recent.reduce((s, e) => s + e.value, 0) / recent.length
        : 0;
    const avgPrevious =
      previous.length > 0
        ? previous.reduce((s, e) => s + e.value, 0) / previous.length
        : 0;

    if (avgPrevious === 0 && avgRecent === 0) return 0;
    if (avgPrevious === 0) return 1; // Crescimento "infinito" → cap em 1

    const rawTrend = (avgRecent - avgPrevious) / avgPrevious;

    // Suaviza com tanh para manter em [-1, 1]
    return Math.tanh(rawTrend);
  }

  private static monthsBetween(start: string, end: string): number {
    const [sy, sm] = start.split('-').map(Number) as [number, number];
    const [ey, em] = end.split('-').map(Number) as [number, number];
    return (ey - sy) * 12 + (em - sm) + 1;
  }
}
