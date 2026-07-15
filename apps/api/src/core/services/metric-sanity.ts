/**
 * Metric sanity — light anomaly flags for absurd financial metrics.
 *
 * Pure helpers: no I/O. Use when surfacing scraped or calculated indicators
 * so UI/API can show a warning badge without hard-rejecting the row.
 *
 * Thresholds are deliberately loose (flag only clear data bugs / edge cases):
 *  - PE (P/L) > 1000 → almost certainly a scrap/calc glitch
 *  - PE < 0 already treated as invalid/null in calcAllIndicators; still flag if present
 *  - DY > 100% → impossible as trailing yield in normal markets
 *  - null/non-positive price → quote missing or bad
 */

export type MetricAnomalyCode =
  | 'pe_negative'
  | 'pe_absurd'
  | 'dy_absurd'
  | 'price_missing'
  | 'price_non_positive'
  | 'pvp_negative';

export interface MetricAnomaly {
  code: MetricAnomalyCode;
  field: string;
  value: number | null;
  message: string;
}

/** Inputs accepted from ranking rows, scrapers, or indicators (snake or camel). */
export interface MetricSanityInput {
  price?: number | null;
  /** P/L — peRatio / pl / pe */
  pe?: number | null;
  peRatio?: number | null;
  pl?: number | null;
  /** Dividend yield % */
  dy?: number | null;
  dividendYield?: number | null;
  /** P/VP */
  pvp?: number | null;
  pbRatio?: number | null;
}

const PE_ABSURD = 1000;
const DY_ABSURD = 100;

function pickPe(m: MetricSanityInput): number | null | undefined {
  if (m.pe !== undefined) return m.pe;
  if (m.peRatio !== undefined) return m.peRatio;
  if (m.pl !== undefined) return m.pl;
  return undefined;
}

function pickDy(m: MetricSanityInput): number | null | undefined {
  if (m.dy !== undefined) return m.dy;
  if (m.dividendYield !== undefined) return m.dividendYield;
  return undefined;
}

function pickPvp(m: MetricSanityInput): number | null | undefined {
  if (m.pvp !== undefined) return m.pvp;
  if (m.pbRatio !== undefined) return m.pbRatio;
  return undefined;
}

/**
 * Returns a list of anomaly flags for the given metrics.
 * Empty array = no absurd values detected (or fields not provided).
 */
export function flagAbsurdMetrics(m: MetricSanityInput): MetricAnomaly[] {
  const flags: MetricAnomaly[] = [];

  if (m.price === null) {
    flags.push({
      code: 'price_missing',
      field: 'price',
      value: null,
      message: 'Preço ausente (null)',
    });
  } else if (m.price !== undefined && (typeof m.price !== 'number' || !(m.price > 0))) {
    flags.push({
      code: 'price_non_positive',
      field: 'price',
      value: typeof m.price === 'number' ? m.price : null,
      message: 'Preço inválido ou não positivo',
    });
  }

  const pe = pickPe(m);
  if (pe !== undefined && pe !== null) {
    if (pe < 0) {
      flags.push({
        code: 'pe_negative',
        field: 'pe',
        value: pe,
        message: 'P/L negativo (prejuízo ou dado inconsistente)',
      });
    } else if (pe > PE_ABSURD) {
      flags.push({
        code: 'pe_absurd',
        field: 'pe',
        value: pe,
        message: `P/L absurdo (> ${PE_ABSURD})`,
      });
    }
  }

  const dy = pickDy(m);
  if (dy !== undefined && dy !== null && dy > DY_ABSURD) {
    flags.push({
      code: 'dy_absurd',
      field: 'dy',
      value: dy,
      message: `Dividend yield absurdo (> ${DY_ABSURD}%)`,
    });
  }

  const pvp = pickPvp(m);
  if (pvp !== undefined && pvp !== null && pvp < 0) {
    flags.push({
      code: 'pvp_negative',
      field: 'pvp',
      value: pvp,
      message: 'P/VP negativo (patrimônio líquido negativo ou dado inconsistente)',
    });
  }

  return flags;
}

/** True when any absurd/missing-critical metric is present. */
export function hasAbsurdMetrics(m: MetricSanityInput): boolean {
  return flagAbsurdMetrics(m).length > 0;
}
