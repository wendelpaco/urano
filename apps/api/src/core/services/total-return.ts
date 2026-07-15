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
function firstCloseOnOrAfter(
  sorted: PricePoint[],
  isoDay: string,
): PricePoint | null {
  for (const p of sorted) {
    if (p.date >= isoDay) return p;
  }
  return null;
}

/**
 * Total return por ano civil: primeiro close ≥ Y-01-01 → primeiro close ≥ Y+1-01-01.
 * Proventos com data em [start, end) (início inclusivo, fim exclusivo).
 */
export function calendarYearTotalReturns(
  prices: PricePoint[],
  dividends: CashEvent[],
  years: number[],
): Record<number, TotalReturnResult | null> {
  const sorted = [...prices]
    .filter((p) => p.close > 0 && /^\d{4}-\d{2}-\d{2}/.test(p.date))
    .sort((a, b) => a.date.localeCompare(b.date));

  const out: Record<number, TotalReturnResult | null> = {};
  for (const y of years) {
    const start = firstCloseOnOrAfter(sorted, `${y}-01-01`);
    const end = firstCloseOnOrAfter(sorted, `${y + 1}-01-01`);
    if (!start || !end || start.close <= 0) {
      out[y] = null;
      continue;
    }
    const divs = dividends.filter(
      (d) => d.value > 0 && d.date >= start.date && d.date < end.date,
    );
    const dividendsSum = +divs.reduce((s, d) => s + d.value, 0).toFixed(6);
    const priceReturnPct = +(((end.close - start.close) / start.close) * 100).toFixed(2);
    const dividendReturnPct = +((dividendsSum / start.close) * 100).toFixed(2);
    out[y] = {
      startDate: start.date,
      endDate: end.date,
      startPrice: start.close,
      endPrice: end.close,
      priceReturnPct,
      dividendReturnPct,
      totalReturnPct: +(priceReturnPct + dividendReturnPct).toFixed(2),
      dividendsSum,
      dividendEvents: divs.length,
      sourceNote:
        'Ano civil: 1º close ≥ Y-01-01 → 1º close ≥ Y+1-01-01 + proventos [start,end).',
    };
  }
  return out;
}

/**
 * DY do ano Y (proventos em Y / preço início Y) → total return do ano Y+1.
 */
export function trailingDyAndNextTotalReturn(
  prices: PricePoint[],
  dividends: CashEvent[],
  years: number[],
): Array<{
  year: number;
  nextYear: number;
  trailingDyPct: number;
  nextTotalReturnPct: number;
}> {
  const annual = calendarYearTotalReturns(prices, dividends, [
    ...years,
    ...years.map((y) => y + 1),
  ]);
  const pairs: Array<{
    year: number;
    nextYear: number;
    trailingDyPct: number;
    nextTotalReturnPct: number;
  }> = [];

  for (const y of years) {
    const trY = annual[y];
    const trNext = annual[y + 1];
    if (!trY || !trNext || trY.startPrice <= 0) continue;
    pairs.push({
      year: y,
      nextYear: y + 1,
      trailingDyPct: +((trY.dividendsSum / trY.startPrice) * 100).toFixed(2),
      nextTotalReturnPct: trNext.totalReturnPct,
    });
  }
  return pairs;
}

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
