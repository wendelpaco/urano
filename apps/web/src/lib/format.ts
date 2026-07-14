// Number / currency / percent formatting helpers.
// All numeric UI in the app runs through these to keep alignment and tone consistent.

const BRL = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  maximumFractionDigits: 2,
});
const BRL_COMPACT = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  notation: "compact",
  maximumFractionDigits: 2,
});
const NUM = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });
const NUM_COMPACT = new Intl.NumberFormat("pt-BR", {
  notation: "compact",
  maximumFractionDigits: 2,
});
const PCT = new Intl.NumberFormat("pt-BR", {
  style: "percent",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function fmtBRL(v: number | null | undefined, compact = false) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return compact ? BRL_COMPACT.format(v) : BRL.format(v);
}
export function fmtNum(v: number | null | undefined, compact = false) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return compact ? NUM_COMPACT.format(v) : NUM.format(v);
}
/** Accepts either fractions (0.12) or already-percent (12). Heuristic: |v|<=1 treated as fraction. */
export function fmtPct(v: number | null | undefined, alreadyPct = false) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const pct = alreadyPct || Math.abs(v) > 1 ? v / 100 : v;
  return PCT.format(pct);
}
export function fmtSigned(v: number | null | undefined, formatter = fmtNum) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return sign + formatter(v);
}
export function toneOf(v: number | null | undefined): "up" | "down" | "flat" {
  if (v === null || v === undefined || Number.isNaN(v) || v === 0) return "flat";
  return v > 0 ? "up" : "down";
}
