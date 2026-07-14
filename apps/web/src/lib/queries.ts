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
  [k: string]: any;
};

export type RankingParams = {
  type?: "stock" | "fii" | "all";
  sort?: string;
  order?: "asc" | "desc";
  limit?: number;
};

export function useRanking(params: RankingParams = {}) {
  return useQuery<Asset[] | { items?: Asset[]; data?: Asset[] }>({
    queryKey: ["ranking", params],
    queryFn: () =>
      apiFetch({
        path: "/analysis/ranking",
        query: params as Record<string, any>,
      }),
    staleTime: 60_000,
  });
}

export function useScreener(params: Record<string, any>) {
  return useQuery({
    queryKey: ["screener", params],
    queryFn: () => apiFetch({ path: "/screener", query: params }),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}

export function useAssetDetail(type: "stock" | "fii", ticker: string) {
  return useQuery({
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
  return useQuery<any>({
    queryKey: ["history", ticker],
    queryFn: () => apiFetch({ path: `/stocks/${ticker}/history` }),
    enabled: Boolean(ticker),
    staleTime: 5 * 60_000,
  });
}

export function useDividends(ticker: string) {
  return useQuery<any>({
    queryKey: ["dividends", ticker],
    queryFn: () => apiFetch({ path: `/dividends/${ticker}` }),
    enabled: Boolean(ticker),
    staleTime: 5 * 60_000,
  });
}

export function useWallets() {
  return useQuery<any>({
    queryKey: ["wallets"],
    queryFn: () => apiFetch({ path: "/wallets" }),
    staleTime: 30_000,
  });
}

export function useWallet(id: string | undefined) {
  return useQuery<any>({
    queryKey: ["wallets", id],
    queryFn: () => apiFetch({ path: `/wallets/${id}` }),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

/** Normalize API responses that may return either `T[]` or `{ items|data: T[] }`. */
export function asArray<T = any>(v: any): T[] {
  if (Array.isArray(v)) return v;
  if (!v) return [];
  if (Array.isArray(v.items)) return v.items;
  if (Array.isArray(v.data)) return v.data;
  if (Array.isArray(v.results)) return v.results;
  return [];
}
