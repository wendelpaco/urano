/**
 * Total return puro (preço + proventos reinvestidos ou cash) — zero I/O.
 * Usa séries reais de closes e eventos de provento.
 */

export interface PricePoint {
  date: string; // YYYY-MM-DD
  close: number;
}

export interface CashEvent {
  date: string;
  value: number; // por cota/ação
}

export interface TotalReturnResult {
  startDate: string;
  endDate: string;
  startPrice: number;
  endPrice: number;
  /** Variação só de preço (%) */
  priceReturnPct: number;
  /** Soma de proventos no período / preço inicial (%) */
  dividendReturnPct: number;
  /** (preço final - inicial + proventos) / inicial (%) — cash, sem reinvestimento */
  totalReturnPct: number;
  dividendsSum: number;
  dividendEvents: number;
  sourceNote: string;
}

/**
 * Total return no intervalo [start, end] com proventos em cash (não reinvestidos).
 * Filtra pontos e eventos com dados reais; exige closes > 0.
 */
export function computeTotalReturn(
  prices: PricePoint[],
  dividends: CashEvent[],
  rangeStart?: string,
  rangeEnd?: string,
): TotalReturnResult | null {
  const sorted = [...prices]
    .filter((p) => p.close > 0 && /^\d{4}-\d{2}-\d{2}/.test(p.date))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length < 2) return null;

  const startBound = rangeStart ?? sorted[0]!.date;
  const endBound = rangeEnd ?? sorted[sorted.length - 1]!.date;

  const inRange = sorted.filter((p) => p.date >= startBound && p.date <= endBound);
  if (inRange.length < 2) return null;

  const start = inRange[0]!;
  const end = inRange[inRange.length - 1]!;
  const divs = dividends.filter(
    (d) => d.value > 0 && d.date >= start.date && d.date <= end.date,
  );
  const dividendsSum = +divs.reduce((s, d) => s + d.value, 0).toFixed(6);

  const priceReturnPct = +(((end.close - start.close) / start.close) * 100).toFixed(2);
  const dividendReturnPct = +((dividendsSum / start.close) * 100).toFixed(2);
  const totalReturnPct = +((priceReturnPct + dividendReturnPct).toFixed(2));

  return {
    startDate: start.date,
    endDate: end.date,
    startPrice: start.close,
    endPrice: end.close,
    priceReturnPct,
    dividendReturnPct,
    totalReturnPct,
    dividendsSum,
    dividendEvents: divs.length,
    sourceNote:
      'Total return cash (preço + soma de proventos / P0). Não reinveste proventos.',
  };
}

/**
 * Momentum simplificado a partir de série de preços até `asOf` (look-ahead free se asOf for a data do score).
 */
export function momentumFromCloses(
  prices: PricePoint[],
  asOf: string,
): { return3m: number | null; return6m: number | null } {
  const sorted = [...prices]
    .filter((p) => p.close > 0 && p.date <= asOf)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length < 2) return { return3m: null, return6m: null };

  const last = sorted[sorted.length - 1]!;
  const asOfDate = new Date(asOf);

  const findNear = (monthsBack: number): number | null => {
    const target = new Date(asOfDate);
    target.setMonth(target.getMonth() - monthsBack);
    const t = target.toISOString().slice(0, 10);
    // último close em ou antes de t
    let found: number | null = null;
    for (const p of sorted) {
      if (p.date <= t) found = p.close;
      else break;
    }
    return found;
  };

  const p3 = findNear(3);
  const p6 = findNear(6);
  return {
    return3m:
      p3 && p3 > 0 ? +(((last.close - p3) / p3) * 100).toFixed(1) : null,
    return6m:
      p6 && p6 > 0 ? +(((last.close - p6) / p6) * 100).toFixed(1) : null,
  };
}
