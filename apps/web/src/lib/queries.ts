import { useCallback, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

// Best-effort typings — backend is source of truth. We keep fields optional and
// let the UI degrade gracefully when a field is missing.

/** Cobertura de dados críticos do score FII (`metadata.data_coverage` / `dataCoverage`). */
export type AssetDataCoverage = {
  percent: number;
  criticalComplete: boolean;
  missingFields: string[];
  policy?: string;
};

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
  /** FII analysis: campos ausentes / % cobertura (F4). */
  dataCoverage?: AssetDataCoverage;
  /** Orientação acionável (API analysis v4). */
  guidance?: InvestmentGuidance;
  diagnosis?: string;
  alerts?: string[];
  structuredReasons?: Array<{ kind: "pro" | "con" | "info"; text: string }>;
  stance?: string;
  stanceLabel?: string;
  stanceTone?: string;
  vacancy?: number;
  sectorPeers?: SectorPeerSummary;
  fundamentus?: {
    available?: boolean;
    snapshot?: Record<string, number | string | null | undefined> | null;
    divergenceMessages?: string[];
  };
  [k: string]: unknown;
};

export type SectorPeerSummary = {
  sector?: string | null;
  peerCount?: number;
  summary?: string;
  medians?: Record<string, number | null>;
  vsSector?: Array<{
    field?: string;
    label?: string;
    self?: number | null;
    sectorMedian?: number | null;
    standing?: string;
    note?: string;
  }>;
  peers?: Array<{
    ticker?: string;
    name?: string | null;
    score?: number | null;
    peRatio?: number | null;
    pbRatio?: number | null;
    roe?: number | null;
    dividendYield?: number | null;
  }>;
};

/** Postura + porquês gerados pelo motor de orientação. */
export type InvestmentGuidance = {
  stance?: string;
  stanceLabel?: string;
  stanceTone?: "positive" | "warning" | "negative" | "muted" | string;
  headline?: string;
  why?: string[];
  risks?: string[];
  ifNotHolding?: string;
  ifHolding?: string;
  nextSteps?: string[];
  whenToRevisit?: string;
  confidence?: string;
  confidenceNote?: string;
  disclaimers?: string[];
  structuredReasons?: Array<{ kind: "pro" | "con" | "info"; text: string }>;
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
  id?: string;
  ticker: string;
  type?: "stock" | "fii" | string;
  sector?: string;
  quantity?: number | null;
  qty?: number | null;
  targetAllocationPercent?: number;
  companyName?: string;
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
    select: (raw) => {
      if (Array.isArray(raw)) return raw.map((a) => normalizeAsset(a));
      if (raw && typeof raw === "object" && Array.isArray(raw.data)) {
        return { ...raw, data: raw.data.map((a) => normalizeAsset(a)) };
      }
      if (raw && typeof raw === "object" && Array.isArray(raw.items)) {
        return { ...raw, items: raw.items.map((a) => normalizeAsset(a)) };
      }
      return raw;
    },
  });
}

/** Extract ranking `meta` when the response is an object wrapper (not a bare array). */
export function rankingMeta(data: RankingResponse | undefined): RankingMeta | undefined {
  if (!data || Array.isArray(data) || typeof data !== "object") return undefined;
  return data.meta;
}

/**
 * Screener de ações (`/screener`) ou FIIs (`/fiis/screener`) conforme `params.type`.
 */
export function useScreener(params: ScreenerParams) {
  const isFii = params.type === "fii";
  const query = isFii ? mapFiiScreenerParams(params) : mapStockScreenerParams(params);
  const path = isFii ? "/fiis/screener" : "/screener";

  return useQuery<Asset[] | { items?: Asset[]; data?: Asset[] }>({
    queryKey: ["screener", path, query],
    queryFn: () => apiFetch({ path, query }),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    select: (raw) => {
      if (Array.isArray(raw)) {
        return raw.map((a) =>
          normalizeAsset({ ...a, type: a.type ?? (isFii ? "fii" : "stock") }),
        );
      }
      if (raw && typeof raw === "object") {
        const obj = raw as { items?: Asset[]; data?: Asset[] };
        if (Array.isArray(obj.data)) {
          return {
            ...obj,
            data: obj.data.map((a) =>
              normalizeAsset({ ...a, type: a.type ?? (isFii ? "fii" : "stock") }),
            ),
          };
        }
        if (Array.isArray(obj.items)) {
          return { ...obj, items: obj.items.map((a) => normalizeAsset(a)) };
        }
      }
      return raw;
    },
  });
}

function mapStockScreenerParams(
  params: ScreenerParams,
): Record<string, string | number | boolean | undefined | null> {
  const out: Record<string, string | number | boolean | undefined | null> = {};
  const map: Record<string, string> = {
    peMin: "minPE",
    peMax: "maxPE",
    pvpMin: "minPVP",
    pvpMax: "maxPVP",
    roeMin: "minROE",
    roeMax: "maxROE",
    dyMin: "minDY",
    dyMax: "maxDY",
    scoreMin: "minScore",
    scoreMax: "maxScore",
    sector: "sector",
    sortBy: "sortBy",
    order: "order",
    limit: "limit",
  };
  for (const [from, to] of Object.entries(map)) {
    const v = params[from];
    if (v !== "" && v !== undefined && v !== null) out[to] = v;
  }
  return out;
}

function mapFiiScreenerParams(
  params: ScreenerParams,
): Record<string, string | number | boolean | undefined | null> {
  const out: Record<string, string | number | boolean | undefined | null> = {};
  if (params.pvpMin) out.pvp_gte = params.pvpMin;
  if (params.pvpMax) out.pvp_lte = params.pvpMax;
  if (params.dyMin) out.dy_gte = params.dyMin;
  if (params.dyMax) out.dy_lte = params.dyMax;
  if (params.scoreMin) out.score_gte = params.scoreMin;
  if (params.scoreMax) out.score_lte = params.scoreMax;
  if (params.liquidityMin) out.liquidity_gte = params.liquidityMin;
  if (params.vacancyMax) out.vacancy_lte = params.vacancyMax;
  if (params.sector) out.segment = params.sector;
  if (params.classification) out.classification = params.classification;
  const sort = String(params.sortBy ?? "score");
  out.sort = ["dy", "pvp", "price", "liquidity", "ticker", "score", "vacancy"].includes(sort)
    ? sort
    : "score";
  if (params.order) out.order = params.order;
  if (params.limit) out.limit = params.limit;
  return out;
}

const asNum = (v: unknown): number | undefined =>
  typeof v === "number" && !Number.isNaN(v) ? v : undefined;

/** Normaliza `dataCoverage` snake/camel ou `metadata.data_coverage` do FII score. */
export function normalizeDataCoverage(raw: unknown): AssetDataCoverage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const nested =
    r.dataCoverage ??
    r.data_coverage ??
    (r.metadata && typeof r.metadata === "object"
      ? ((r.metadata as Record<string, unknown>).data_coverage ??
        (r.metadata as Record<string, unknown>).dataCoverage)
      : undefined);
  const src = (nested && typeof nested === "object" ? nested : r) as Record<string, unknown>;
  const percent = asNum(src.percent);
  if (percent === undefined) return undefined;
  const missingRaw = src.missingFields ?? src.missing_fields;
  const missingFields = Array.isArray(missingRaw)
    ? missingRaw.map((x) => String(x)).filter(Boolean)
    : [];
  const criticalComplete = Boolean(
    src.criticalComplete ?? src.critical_complete ?? missingFields.length === 0,
  );
  const policy = typeof src.policy === "string" ? src.policy : undefined;
  return { percent, criticalComplete, missingFields, policy };
}

/**
 * Unifica nomes de campos entre ranking/screener/allocate/detail.
 * API pode mandar peRatio|pe, dividendYield|dy, changePercent|changePct, assetType|type.
 */
export function normalizeAsset(raw: Asset | Record<string, unknown>): Asset {
  if (!raw || typeof raw !== "object") return raw as Asset;
  const r = raw as Record<string, unknown>;
  const ind = (r.indicators ?? {}) as Record<string, unknown>;

  const dy = asNum(r.dy) ?? asNum(r.dividendYield) ?? asNum(ind.dividendYield) ?? asNum(ind.dy);
  const pe = asNum(r.pe) ?? asNum(r.peRatio) ?? asNum(r.pl) ?? asNum(ind.peRatio);
  const pvp = asNum(r.pvp) ?? asNum(r.pbRatio) ?? asNum(ind.pbRatio) ?? asNum(ind.pvp);
  const roe = asNum(r.roe) ?? asNum(ind.roe);
  const changePct =
    asNum(r.changePct) ?? asNum(r.changePercent) ?? asNum(r.dailyChangePct) ?? asNum(ind.changePct);

  const typeRaw = r.type ?? r.assetType;
  const type =
    typeRaw === "fii" || typeRaw === "stock"
      ? typeRaw
      : typeof typeRaw === "string"
        ? typeRaw
        : undefined;

  return {
    ...(r as Asset),
    type,
    dy,
    pe,
    pvp,
    roe,
    changePct,
    price: asNum(r.price) ?? (r.price as number | undefined),
    score: asNum(r.score) ?? (r.score as number | undefined),
    marketCap: asNum(r.marketCap) ?? asNum(ind.marketCap),
    netMargin: asNum(r.netMargin) ?? asNum(ind.netMargin),
    debtEquity: asNum(r.debtEquity) ?? asNum(r.debtToEquity) ?? asNum(ind.debtToEquity),
    sector: (r.sector as string | undefined) ?? (r.segment as string | undefined) ?? undefined,
    stance: (r.stance as string | undefined) ?? undefined,
    stanceLabel: (r.stanceLabel as string | undefined) ?? undefined,
    stanceTone: (r.stanceTone as string | undefined) ?? undefined,
    vacancy: asNum(r.vacancy) ?? asNum(r.vacancyPct),
  };
}

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
  const flat = normalizeAsset({
    ...raw,
    pillars: raw.pillars ?? raw.breakdown ?? raw.pilares ?? raw.scores,
    type: raw.type ?? type,
  });
  // F4: preservar cobertura de dados (top-level dataCoverage ou metadata.data_coverage).
  const coverage = normalizeDataCoverage(raw);
  if (coverage) flat.dataCoverage = coverage;

  // Guidance + reasons tipados (analysis v4)
  if (raw.guidance && typeof raw.guidance === "object") {
    flat.guidance = raw.guidance as InvestmentGuidance;
  }
  if (Array.isArray(raw.structuredReasons) && raw.structuredReasons.length > 0) {
    flat.reasons = raw.structuredReasons;
    flat.structuredReasons = raw.structuredReasons as Asset["structuredReasons"];
  } else if (flat.guidance?.structuredReasons?.length) {
    flat.reasons = flat.guidance.structuredReasons;
  } else if (Array.isArray(raw.reasons) || Array.isArray(raw.alerts)) {
    // Converte strings soltas → pro/con para o painel
    const pros = (Array.isArray(raw.reasons) ? raw.reasons : [])
      .map((r) => (typeof r === "string" ? { kind: "pro" as const, text: r } : r))
      .filter(Boolean);
    const cons = (Array.isArray(raw.alerts) ? raw.alerts : [])
      .map((a) =>
        typeof a === "string" ? { kind: "con" as const, text: a } : a,
      )
      .filter(Boolean);
    if (pros.length + cons.length > 0) {
      flat.reasons = [...pros, ...cons];
    }
  }

  if (raw.fundamentus && typeof raw.fundamentus === "object") {
    flat.fundamentus = raw.fundamentus as Asset["fundamentus"];
  }
  if (raw.sectorPeers && typeof raw.sectorPeers === "object") {
    flat.sectorPeers = raw.sectorPeers as SectorPeerSummary;
  }
  if (typeof raw.diagnosis === "string") flat.diagnosis = raw.diagnosis;
  if (typeof raw.stanceLabel === "string") flat.stanceLabel = raw.stanceLabel;
  if (typeof raw.stance === "string") flat.stance = raw.stance;
  if (typeof raw.stanceTone === "string") flat.stanceTone = raw.stanceTone;

  if (type === "fii") {
    flat.dy = asNum(raw.dividendYield ?? raw.dy) ?? flat.dy;
    flat.pvp = asNum(raw.pvp) ?? flat.pvp;
    flat.price = asNum(raw.price) ?? flat.price;
    flat.liquidity = asNum(raw.liquidity);
    if (!Array.isArray(flat.reasons) && typeof raw.explanation === "string" && raw.explanation) {
      flat.reasons = [raw.explanation];
    }
  } else {
    flat.dy = asNum(ind.dividendYield) ?? flat.dy;
    flat.pe = asNum(ind.peRatio) ?? flat.pe;
    flat.pvp = asNum(ind.pbRatio) ?? flat.pvp;
    flat.roe = asNum(ind.roe) ?? flat.roe;
    flat.roic = asNum(ind.roic) ?? flat.roic;
    flat.marketCap = asNum(ind.marketCap) ?? flat.marketCap;
    flat.netMargin = asNum(ind.netMargin) ?? flat.netMargin;
    flat.debtEquity = asNum(ind.debtToEquity) ?? flat.debtEquity;
    flat.eps = asNum(ind.eps);
    flat.bvps = asNum(ind.bvps);
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
  const obj = v as { items?: unknown; data?: unknown; results?: unknown; assets?: unknown };
  if (Array.isArray(obj.items)) return obj.items as T[];
  if (Array.isArray(obj.data)) return obj.data as T[];
  if (Array.isArray(obj.results)) return obj.results as T[];
  if (Array.isArray(obj.assets)) return obj.assets as T[];
  return [];
}

/** Extrai lista de ativos e aplica normalizeAsset (pe/dy/changePct/type). */
export function asAssets(v: unknown): Asset[] {
  return asArray<Asset | Record<string, unknown>>(v).map((row) => normalizeAsset(row));
}

/** Normalize allocation rows (API: assetType / allocationAmount / allocationPercent). */
export function normalizeAllocationAsset(raw: Record<string, unknown>) {
  return {
    ...raw,
    type: (raw.type ?? raw.assetType) as string | undefined,
    amount: asNum(raw.amount) ?? asNum(raw.allocationAmount),
    // API manda % 0–100; UI fmtPct com alreadyPct=true
    weight: asNum(raw.weight) ?? asNum(raw.allocationPercent),
    quantity: asNum(raw.quantity),
    price: asNum(raw.price),
    score: asNum(raw.score),
    ticker: String(raw.ticker ?? ""),
    name: raw.name as string | undefined,
    sector: raw.sector as string | undefined,
  };
}

// ─── Score validation (backtest verdict) ─────────────────────────────────────

export type ScoreValidation = {
  scoreVersion: string;
  decisionUseAllowed: boolean;
  decisionBlockers: string[];
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
      source?: string;
    };
  } | null;
  strategy?: {
    runId: string;
    scoreVersion: string;
    n: number;
    summary: {
      avgPortfolio: number | null;
      avgUniverse: number | null;
      avgIbov: number | null;
      winYearsVsUniverse: number;
      winYearsVsIbov: number;
      totalYears: number;
      ibovYears: number;
      byYear: Array<{
        year: number;
        portfolioReturn: number;
        universeReturn: number;
        ibovReturn: number | null;
      }>;
    };
  } | null;
  fiiBacktest?: {
    runId: string;
    createdAt?: string;
    observations: number;
    tickers: number;
    byYear: Array<{
      year: number;
      avgTotal: number;
      avgPrice: number;
      avgDiv: number;
      n: number;
    }>;
    dyPredictsNext: {
      n: number;
      correlation: number;
      interpretation: string;
    };
    dataQuality?: Record<string, unknown>;
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
