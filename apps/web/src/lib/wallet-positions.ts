/**
 * Quantidades reais por carteira — a API de wallets guarda só ticker + % alvo.
 * Persistimos qty no browser para o simulador de aporte respeitar concentração.
 */

const KEY = (walletId: string) => `urano.wallet.qty.${walletId}`;

export type QtyMap = Record<string, number>;

export function loadWalletQuantities(walletId: string): QtyMap {
  if (typeof window === "undefined" || !walletId) return {};
  try {
    const raw = localStorage.getItem(KEY(walletId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: QtyMap = {};
    for (const [t, q] of Object.entries(parsed as Record<string, unknown>)) {
      const n = Number(q);
      if (t && Number.isFinite(n) && n > 0) out[t.toUpperCase()] = n;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveWalletQuantities(walletId: string, map: QtyMap): void {
  if (typeof window === "undefined" || !walletId) return;
  try {
    const clean: QtyMap = {};
    for (const [t, q] of Object.entries(map)) {
      if (Number.isFinite(q) && q > 0) clean[t.toUpperCase()] = q;
    }
    localStorage.setItem(KEY(walletId), JSON.stringify(clean));
  } catch {
    /* quota / private mode */
  }
}

export function positionsFromTickers(
  tickers: string[],
  qtyMap: QtyMap,
): Array<{ ticker: string; quantity: number }> {
  const out: Array<{ ticker: string; quantity: number }> = [];
  for (const t of tickers) {
    const ticker = t.toUpperCase();
    const quantity = qtyMap[ticker];
    if (quantity != null && quantity > 0) out.push({ ticker, quantity });
  }
  return out;
}
