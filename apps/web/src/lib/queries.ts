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
  HistoryPoint[] | { data?: HistoryPoint[]; items?: HistoryPoint[]; history?: HistoryPoint[] };

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
  | { data?: DividendEntry[]; items?: DividendEntry[]; dividends?: DividendEntry[] };

export function useRanking(params: RankingParams = {}) {
  return useQuery<Asset[] | { items?: Asset[]; data?: Asset[] }>({
    queryKey: ["ranking", params],
    queryFn: () =>
      apiFetch({
        path: "/analysis/ranking",
        query: params,
      }),
    staleTime: 60_000,
  });
}

export function useScreener(params: ScreenerParams) {
  return useQuery<Asset[] | { items?: Asset[]; data?: Asset[] }>({
    queryKey: ["screener", params],
    queryFn: () => apiFetch({ path: "/screener", query: params }),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
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
