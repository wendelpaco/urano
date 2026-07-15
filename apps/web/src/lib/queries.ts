import { useCallback, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

// Best-effort typings — backend is source of truth. We keep fields optional and
// let the UI degrade gracefully when a field is missing.

export type Asset = {
  ticker: string;
  name?: string;
  type?: "stock" | "fii" | string;
  sector?: string;
  price?: number;
  change?: number;
  changePct?: number;
  score?: number;
  dy?: number;
  pe?: number;
  pvp?: number;
  roe?: number;
  marketCap?: number;
  liquidity?: number;
  // Detail-page-only fields (research.$type.$ticker) — best-effort, backend varies naming.
  companyName?: string;
  description?: string;
  roic?: number;
  netMargin?: number;
  debtEquity?: number;
  eps?: number;
  bvps?: number;
  overallScore?: number;
  pontuacao?: number;
  pontos?: number;
  pillars?: unknown;
  pilares?: unknown;
  scores?: unknown;
  reasons?: unknown;
  motivos?: unknown;
  [k: string]: unknown;
};

export type RankingParams = {
  type?: "stock" | "fii" | "all";
  sort?: string;
  order?: "asc" | "desc";
  limit?: number;
};

/** Trust badge payload from GET /analysis/ranking (`meta` is optional for older caches). */
export type RankingMeta = {
  scoreVersion?: string;
  verdict?: "edge" | "quality-filter" | "pending" | string;
};

export type RankingResponse =
  | Asset[]
  | {
      items?: Asset[];
      data?: Asset[];
      meta?: RankingMeta;
      type?: string;
      total?: number;
      filters?: unknown;
    };

export type ScreenerParams = Record<string, string | number | boolean | undefined | null>;

export type Position = {
  ticker: string;
  type?: "stock" | "fii" | string;
  sector?: string;
  quantity?: number;
  qty?: number;
  price?: number;
  value?: number;
  total?: number;
  weight?: number;
  changePct?: number;
  score?: number;
  [k: string]: unknown;
};

export type Wallet = {
  id: string | number;
  name?: string;
  strategy?: string;
  profile?: string;
  value?: number;
  total?: number;
  changePct?: number;
  positions?: unknown;
  assets?: unknown;
  [k: string]: unknown;
};

export type HistoryPoint = {
  date?: string;
  d?: string;
  time?: string;
  close?: number;
  price?: number;
  value?: number;
  v?: number;
};
export type HistoryResponse =
  | HistoryPoint[]
  | {
      data?: HistoryPoint[];
      items?: HistoryPoint[];
      history?: HistoryPoint[];
      // Backend `/stocks/:ticker/history` returns `{ points: [...] }`.
      points?: HistoryPoint[];
    };

export type DividendEntry = {
  date?: string;
  paymentDate?: string;
  d?: string;
  value?: number;
  amount?: number;
  v?: number;
};
export type DividendsResponse =
  | DividendEntry[]
  | {
      data?: DividendEntry[];
      items?: DividendEntry[];
      dividends?: DividendEntry[];
      // Backend `/dividends/:ticker` returns dated monthly events here; `data` holds
      // annual DMPL rows with no date/value and is not chartable.
      monthlyHistory?: DividendEntry[];
    };

export function useRanking(params: RankingParams = {}) {
  return useQuery<RankingResponse>({
    queryKey: ["ranking", params],
    queryFn: () =>
      apiFetch({
        path: "/analysis/ranking",
        query: params,
      }),
    staleTime: 60_000,
  });
}

/** Extract ranking `meta` when the response is an object wrapper (not a bare array). */
export function rankingMeta(data: RankingResponse | undefined): RankingMeta | undefined {
  if (!data || Array.isArray(data) || typeof data !== "object") return undefined;
  return data.meta;
}

export function useScreener(params: ScreenerParams) {
  return useQuery<Asset[] | { items?: Asset[]; data?: Asset[] }>({
    queryKey: ["screener", params],
    queryFn: () => apiFetch({ path: "/screener", query: params }),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}

const asNum = (v: unknown): number | undefined =>
  typeof v === "number" && !Number.isNaN(v) ? v : undefined;

/**
 * The detail endpoints return different shapes per asset class:
 * - stocks nest metrics under `indicators` (peRatio/pbRatio/dividendYield/…),
 * - FIIs expose dividendYield/pvp/price/liquidity at the top level and omit P/L,
 *   ROE, margins, etc. (semantically N/A for a fund).
 * Both put the score pillars in `breakdown`; FIIs carry `explanation` instead of
 * a `reasons[]`. The UI reads a single flat shape, so normalize here.
 */
export function flattenAssetDetail(raw: Asset, type: "stock" | "fii"): Asset {
  if (!raw || typeof raw !== "object") return raw;
  const ind = (raw.indicators ?? {}) as Record<string, unknown>;
  const flat: Asset = {
    ...raw,
    pillars: raw.pillars ?? raw.breakdown ?? raw.pilares ?? raw.scores,
  };
  if (type === "fii") {
    flat.dy = asNum(raw.dividendYield ?? raw.dy);
    flat.pvp = asNum(raw.pvp);
    flat.price = asNum(raw.price);
    flat.liquidity = asNum(raw.liquidity);
    if (!Array.isArray(raw.reasons) && typeof raw.explanation === "string" && raw.explanation) {
      flat.reasons = [raw.explanation];
    }
  } else {
    flat.dy = asNum(ind.dividendYield);
    flat.pe = asNum(ind.peRatio);
    flat.pvp = asNum(ind.pbRatio);
    flat.roe = asNum(ind.roe);
    flat.marketCap = asNum(ind.marketCap);
    flat.netMargin = asNum(ind.netMargin);
    flat.debtEquity = asNum(ind.debtToEquity);
    flat.eps = asNum(ind.eps);
    flat.bvps = asNum(ind.bvps);
    // The API does not compute ROIC for stocks; leave undefined → renders "—".
  }
  return flat;
}

export function useAssetDetail(type: "stock" | "fii", ticker: string) {
  return useQuery<Asset>({
    queryKey: ["asset", type, ticker],
    queryFn: () =>
      apiFetch({
        path: type === "fii" ? `/analysis/fiis/${ticker}` : `/analysis/stocks/${ticker}`,
      }),
    enabled: Boolean(ticker),
    staleTime: 60_000,
    select: (raw) => flattenAssetDetail(raw, type),
  });
}

export function useHistory(ticker: string) {
  return useQuery<HistoryResponse>({
    queryKey: ["history", ticker],
    queryFn: () => apiFetch({ path: `/stocks/${ticker}/history` }),
    enabled: Boolean(ticker),
    staleTime: 5 * 60_000,
  });
}

export function useLazySearch(query: string) {
  return useQuery<{ results?: LazyAsset[]; source?: string; message?: string }>({
    queryKey: ["lazySearch", query],
    queryFn: () => apiFetch({ path: "/search", query: { q: query } }),
    enabled: Boolean(query) && query.length >= 2,
    staleTime: 30_000,
    retry: 1,
  });
}

export type LazyAsset = {
  ticker: string;
  name: string;
  type: "stock" | "fii";
  price: number;
  change: number;
  changePct: number;
  score: number;
  sector: string | null;
  dy?: number;
  pl?: number;
  pvp?: number;
  roe?: number;
  category?: string;
  source: string;
};

export function useDividends(ticker: string) {
  return useQuery<DividendsResponse>({
    queryKey: ["dividends", ticker],
    queryFn: () => apiFetch({ path: `/dividends/${ticker}` }),
    enabled: Boolean(ticker),
    staleTime: 5 * 60_000,
  });
}

export function useWallets() {
  return useQuery<Wallet[] | { items?: Wallet[]; data?: Wallet[] }>({
    queryKey: ["wallets"],
    queryFn: () => apiFetch({ path: "/wallets" }),
    staleTime: 30_000,
  });
}

export function useWallet(id: string | undefined) {
  return useQuery<Wallet>({
    queryKey: ["wallets", id],
    queryFn: () => apiFetch({ path: `/wallets/${id}` }),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

/** Normalize API responses that may return either `T[]` or `{ items|data: T[] }`. */
export function asArray<T = unknown>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (!v || typeof v !== "object") return [];
  const obj = v as { items?: unknown; data?: unknown; results?: unknown };
  if (Array.isArray(obj.items)) return obj.items as T[];
  if (Array.isArray(obj.data)) return obj.data as T[];
  if (Array.isArray(obj.results)) return obj.results as T[];
  return [];
}

// ─── Score validation (backtest verdict) ─────────────────────────────────────

export type ScoreValidation = {
  scoreVersion: string;
  validatedAt: string | null;
  yearsTested: number[];
  verdict: "edge" | "quality-filter" | "pending";
  summary: string;
  topN: {
    n: number;
    avgPortfolio: number;
    avgMarket: number;
    winYears: number;
    totalYears: number;
  } | null;
  pillarCorrelations: Record<string, number> | null;
  dataPolicy?: {
    freeSourcesOnly?: boolean;
    fundamentals?: string;
    prices?: string;
    macro?: string;
    dividends?: string;
  };
  ibov?: {
    source: string;
    symbol: string;
    asOf: string;
    byYear: Record<string, number | null>;
    yearsWithData: number[];
    note: string;
    vsTopN?: {
      n: number;
      avgPortfolio: number;
      avgIbov: number | null;
      ibovYears: number;
      deltaAvgPp: number | null;
    };
  } | null;
  generatedAt?: string;
};

export function useScoreValidation() {
  return useQuery<ScoreValidation>({
    queryKey: ["scoreValidation"],
    queryFn: () => apiFetch({ path: "/analysis/validation" }),
    staleTime: 30 * 60_000,
  });
}

export function useBenchmarks() {
  return useQuery<{
    total?: number;
    data?: Array<{
      id: string;
      name: string;
      yahooSymbol: string;
      price: number | null;
      changePercent: number | null;
      source: string;
      asOf: string | null;
      error?: string;
    }>;
    note?: string;
  }>({
    queryKey: ["benchmarks"],
    queryFn: () => apiFetch({ path: "/benchmarks" }),
    staleTime: 120_000,
  });
}

export function useBenchmark(id: string | undefined, range = "1y") {
  return useQuery<Record<string, unknown>>({
    queryKey: ["benchmark", id, range],
    queryFn: () => apiFetch({ path: `/benchmarks/${id}`, query: { range } }),
    enabled: Boolean(id),
    staleTime: 120_000,
  });
}

// ─── Macro ───────────────────────────────────────────────────────────────────

export type MacroIndicator = {
  code: string;
  name: string;
  latest: { date: string; value: number } | null;
};

export function useMacro() {
  return useQuery<{ total?: number; data?: MacroIndicator[] }>({
    queryKey: ["macro"],
    queryFn: () => apiFetch({ path: "/macro" }),
    staleTime: 15 * 60_000,
  });
}

export function useMacroSeries(series: string | undefined, limit = 24) {
  return useQuery<{
    code?: string;
    name?: string;
    unit?: string;
    history?: Array<{ date: string; value: number }>;
    latest?: { date: string; value: number };
  }>({
    queryKey: ["macro", series, limit],
    queryFn: () => apiFetch({ path: `/macro/${series}`, query: { limit } }),
    enabled: Boolean(series),
    staleTime: 15 * 60_000,
  });
}

// ─── Technical indicators ────────────────────────────────────────────────────

export function useTechnicalIndicators(ticker: string) {
  return useQuery<Record<string, unknown>>({
    queryKey: ["technicalIndicators", ticker],
    queryFn: () => apiFetch({ path: `/stocks/${ticker}/indicators` }),
    enabled: Boolean(ticker),
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

// ─── Stock stats ─────────────────────────────────────────────────────────────

export function useStockStats(ticker: string) {
  return useQuery<Record<string, unknown>>({
    queryKey: ["stockStats", ticker],
    queryFn: () => apiFetch({ path: `/stocks/${ticker}/stats` }),
    enabled: Boolean(ticker),
    staleTime: 60_000,
    retry: 1,
  });
}

// ─── Dividends normalize ─────────────────────────────────────────────────────

/** Normalize flexible dividend API shapes into `{ d, v }` series. */
export function normalizeDividends(raw: DividendsResponse | undefined): { d: string; v: number }[] {
  if (!raw) return [];
  const arr = Array.isArray(raw)
    ? raw
    : (raw.monthlyHistory ?? raw.data ?? raw.items ?? raw.dividends ?? []);
  if (!Array.isArray(arr)) return [];
  return arr
    .map((p) => ({
      d: (p.date ?? p.paymentDate ?? p.d ?? "").toString().slice(0, 10),
      v: Number(p.value ?? p.amount ?? p.v),
    }))
    .filter((p) => p.d && !Number.isNaN(p.v));
}

// ─── Watchlist (localStorage) ────────────────────────────────────────────────

export const WATCHLIST_KEY = "urano.watchlist";
export const WATCHLIST_EVENT = "urano:watchlist";

export type WatchlistItem = {
  ticker: string;
  type: "stock" | "fii";
};

let watchlistCache: WatchlistItem[] = [];
let watchlistRaw: string | null = null;

function parseWatchlist(raw: string | null): WatchlistItem[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((x) => {
        if (!x || typeof x !== "object") return null;
        const rec = x as Record<string, unknown>;
        const ticker = String(rec.ticker ?? "")
          .trim()
          .toUpperCase();
        const type = rec.type === "fii" ? "fii" : "stock";
        if (!ticker) return null;
        return { ticker, type } as WatchlistItem;
      })
      .filter((x): x is WatchlistItem => Boolean(x));
  } catch {
    return [];
  }
}

/** Stable snapshot for useSyncExternalStore (must not allocate a new array every call). */
function getWatchlistSnapshot(): WatchlistItem[] {
  if (typeof window === "undefined") return watchlistCache;
  const raw = localStorage.getItem(WATCHLIST_KEY);
  if (raw === watchlistRaw) return watchlistCache;
  watchlistRaw = raw;
  watchlistCache = parseWatchlist(raw);
  return watchlistCache;
}

function writeWatchlist(items: WatchlistItem[]) {
  if (typeof window === "undefined") return;
  const raw = JSON.stringify(items);
  localStorage.setItem(WATCHLIST_KEY, raw);
  watchlistRaw = raw;
  watchlistCache = items;
  window.dispatchEvent(new Event(WATCHLIST_EVENT));
}

function subscribeWatchlist(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  const handler = () => onStoreChange();
  window.addEventListener(WATCHLIST_EVENT, handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener(WATCHLIST_EVENT, handler);
    window.removeEventListener("storage", handler);
  };
}

const EMPTY_WATCHLIST: WatchlistItem[] = [];

/** Reactive watchlist backed by `localStorage` (`urano.watchlist`). */
export function useWatchlist() {
  const items = useSyncExternalStore(
    subscribeWatchlist,
    getWatchlistSnapshot,
    () => EMPTY_WATCHLIST,
  );

  const add = useCallback((item: WatchlistItem) => {
    const ticker = item.ticker.trim().toUpperCase();
    if (!ticker) return;
    const type: "stock" | "fii" = item.type === "fii" ? "fii" : "stock";
    const current = getWatchlistSnapshot();
    if (current.some((x) => x.ticker === ticker)) return;
    writeWatchlist([...current, { ticker, type }]);
  }, []);

  const remove = useCallback((ticker: string) => {
    const t = ticker.trim().toUpperCase();
    writeWatchlist(getWatchlistSnapshot().filter((x) => x.ticker !== t));
  }, []);

  const clear = useCallback(() => {
    writeWatchlist([]);
  }, []);

  return { items, add, remove, clear };
}
