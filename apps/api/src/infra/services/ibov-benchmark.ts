/**
 * IBOV real via Yahoo Finance (^BVSP) — gratuito, sem API key.
 * Usado para estatísticas de validação do score vs índice oficial de mercado.
 */

import { getOrSet } from './redis.ts';
import { stockQuoteService } from './stock-quote-service.ts';
import { calendarYearReturnsFromCloses } from '../../core/services/backtest-analysis.ts';

export interface IbovBenchmarkResult {
  source: 'yahoo';
  symbol: string;
  asOf: string;
  /** Retorno % por ano civil (dados reais da série Yahoo). */
  byYear: Record<number, number | null>;
  yearsWithData: number[];
  note: string;
}

/**
 * Busca histórico longo do IBOV e calcula retornos anuais civis.
 * Cache Redis 6h — série diária não muda intraday de forma relevante para isso.
 */
export async function fetchIbovCalendarReturns(
  years: number[],
): Promise<IbovBenchmarkResult> {
  const cacheKey = `ibov:calendar-returns:${[...years].sort().join(',')}`;

  return getOrSet(cacheKey, 6 * 3600, async () => {
    // 10y cobre 2015–2024+; se Yahoo recortar, anos sem dado ficam null
    const history = await stockQuoteService.getIndexHistory('^BVSP', '10y');
    const points = history.points.map((p) => ({ date: p.date, close: p.close }));
    const byYear = calendarYearReturnsFromCloses(points, years);
    const yearsWithData = years.filter((y) => byYear[y] != null);

    return {
      source: 'yahoo' as const,
      symbol: '^BVSP',
      asOf: history.asOf,
      byYear,
      yearsWithData,
      note:
        'Retornos civis do Ibovespa a partir de closes Yahoo (^BVSP). Não é feed oficial B3; uso estatístico/pessoal.',
    };
  });
}
