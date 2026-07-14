/**
 * MarketDataService — Dados de mercado em tempo real via Yahoo Finance.
 *
 * Enriquece a análise com:
 * - Retorno dos últimos 3 e 6 meses
 * - Distância do topo histórico de 52 semanas (quanto caiu?)
 * - Volatilidade anualizada (desvio padrão dos retornos diários)
 */

import { stockQuoteService, type StockHistoryPoint } from './stock-quote-service.ts';
import { withRetry } from '../../shared/retry.ts';

export interface MarketMomentum {
  ticker: string;
  price: number;
  /** Retorno nos últimos 3 meses (%) */
  return3m: number | null;
  /** Retorno nos últimos 6 meses (%) */
  return6m: number | null;
  /** Queda do topo de 52 semanas (%) — 0 se estiver no topo */
  drawdownFrom52WeekHigh: number | null;
  /** Volatilidade anualizada (%) */
  annualizedVolatility: number | null;
  /** Volume médio diário (3 meses) */
  avgVolume: number | null;
}

export class MarketDataService {
  /**
   * Busca indicadores de momento para um ticker.
   * Usa dados do Yahoo Finance (cache de 30s no StockQuoteService).
   */
  async getMomentum(ticker: string): Promise<MarketMomentum> {
    const price = await this.getPrice(ticker);

    // Busca histórico de 6 meses para calcular retornos e volatilidade
    let return3m: number | null = null;
    let return6m: number | null = null;
    let volatility: number | null = null;
    let drawdown52w: number | null = null;

    try {
      const history = await withRetry(
        () => stockQuoteService.getHistory(ticker, '6mo'),
        { maxRetries: 1, initialDelay: 500, maxDelay: 2000, timeout: 10_000 },
      );

      if (history.points.length >= 2) {
        const closes = history.points.map((p) => p.close).filter((c) => c > 0);
        if (closes.length >= 2) {
          const current = closes[closes.length - 1]!;

          // Retorno 6M
          if (closes[0]) {
            return6m = +(((current - closes[0]) / closes[0]) * 100).toFixed(1);
          }

          // Retorno 3M (~metade dos pontos)
          const mid = Math.floor(closes.length / 2);
          if (closes[mid]) {
            return3m = +(((current - closes[mid]) / closes[mid]) * 100).toFixed(1);
          }

          // Volatilidade anualizada
          volatility = this.calculateVolatility(closes);
        }
      }
    } catch {
      // Yahoo indisponível → sem momento
    }

    // Busca high de 52 semanas via Yahoo quote (já cacheado)
    try {
      const quote = await stockQuoteService.getQuote(ticker);
      const avgVolume = quote.volume;

      // Yahoo não retorna 52w high/low diretamente na v8 API de quote.
      // Usamos o preço atual vs preço de 1 ano atrás como proxy.
      const history1y = await withRetry(
        () => stockQuoteService.getHistory(ticker, '1y'),
        { maxRetries: 1, initialDelay: 500, maxDelay: 2000, timeout: 10_000 },
      );

      if (history1y.points.length >= 2) {
        const yearCloses = history1y.points.map((p) => p.close).filter((c) => c > 0);
        const max52w = Math.max(...yearCloses);
        if (max52w > 0) {
          drawdown52w = +(((max52w - price) / max52w) * 100).toFixed(1);
        }
      }

      return {
        ticker,
        price,
        return3m,
        return6m,
        drawdownFrom52WeekHigh: drawdown52w,
        annualizedVolatility: volatility,
        avgVolume,
      };
    } catch {
      return {
        ticker,
        price,
        return3m,
        return6m,
        drawdownFrom52WeekHigh: drawdown52w,
        annualizedVolatility: volatility,
        avgVolume: null,
      };
    }
  }

  private async getPrice(ticker: string): Promise<number> {
    try {
      const quote = await stockQuoteService.getQuote(ticker);
      return quote.price;
    } catch {
      return 0;
    }
  }

  /**
   * Calcula volatilidade anualizada a partir de uma série de preços.
   * Usa desvio padrão dos retornos diários × sqrt(252).
   */
  private calculateVolatility(closes: number[]): number {
    if (closes.length < 5) return 0;

    const returns: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      if (closes[i - 1]! > 0) {
        returns.push(Math.log(closes[i]! / closes[i - 1]!));
      }
    }

    if (returns.length < 2) return 0;

    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
    const dailyVol = Math.sqrt(variance);

    // Anualizada: daily × sqrt(252)
    return +(dailyVol * Math.sqrt(252) * 100).toFixed(1);
  }
}

export const marketDataService = new MarketDataService();
