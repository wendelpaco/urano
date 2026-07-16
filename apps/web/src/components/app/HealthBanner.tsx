import { useQuery } from "@tanstack/react-query";
import { apiFetch, ApiError } from "@/lib/api";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ExternalLink, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";

export type HealthSource = {
  name: string;
  status?: string;
  coverage?: number;
  freshness?: string;
  lastUpdate?: string;
};

export type HealthWarning = {
  level?: "warn" | "error" | "info" | string;
  message: string;
  source?: string;
  details?: unknown;
};

export type HealthData = {
  status?: string;
  sources?: HealthSource[];
  warnings?: HealthWarning[];
  fundamentals?: {
    totalCompanies?: number;
    withFundamentals?: number;
    freshCompanies?: number;
    byFiscalYear?: Array<{ fiscalYear: number; companies: number }>;
  };
  jobs?: {
    enabled?: number;
    failing?: number;
    lastRunAt?: string | null;
  };
  generatedAt?: string;
};

/** API may send warnings as string[] or { message }[]. */
function normalizeWarnings(raw: unknown): HealthWarning[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((w) => {
    if (typeof w === "string") {
      return { level: "warn", message: w, source: "system" };
    }
    if (w && typeof w === "object") {
      const o = w as Record<string, unknown>;
      const message = String(o.message ?? o.msg ?? o.text ?? JSON.stringify(o));
      return {
        level: (o.level as string) ?? "warn",
        message,
        source: o.source as string | undefined,
        details: o.details,
      };
    }
    return { level: "warn", message: String(w) };
  });
}

/** Build sources panel when API omits `sources` (common on /health/data). */
function deriveSources(data: HealthData): HealthSource[] {
  if (Array.isArray(data.sources) && data.sources.length > 0) return data.sources;

  const f = data.fundamentals;
  const j = data.jobs;
  const sources: HealthSource[] = [];

  if (f) {
    const total = f.totalCompanies ?? 0;
    const withF = f.withFundamentals ?? 0;
    const fresh = f.freshCompanies ?? 0;
    const coverage = total > 0 ? withF / total : 0;
    const freshness = total > 0 ? fresh / total : 0;
    sources.push({
      name: "CVM Fundamentals",
      status: coverage >= 0.7 ? "ok" : coverage >= 0.4 ? "warn" : "error",
      coverage,
      freshness: freshness >= 0.5 ? "ok" : "stale",
      lastUpdate: data.generatedAt,
    });
  }

  if (j) {
    sources.push({
      name: "Job Scheduler",
      status: (j.failing ?? 0) > 0 ? "warn" : "ok",
      coverage: j.enabled && j.enabled > 0 ? 1 : 0,
      freshness: j.lastRunAt ? "ok" : "unknown",
      lastUpdate: j.lastRunAt ?? undefined,
    });
  }

  sources.push({
    name: "Market Quotes (I10/Yahoo)",
    status: "ok",
    coverage: undefined,
    freshness: "live-cache",
    lastUpdate: data.generatedAt,
  });

  return sources;
}

function normalizeHealthPayload(raw: HealthData): HealthData {
  const warnings = normalizeWarnings(raw.warnings);
  const sources = deriveSources(raw);
  const hasError = warnings.some((w) => w.level === "error");
  const hasWarn = warnings.length > 0;
  return {
    ...raw,
    warnings,
    sources,
    status: raw.status ?? (hasError ? "error" : hasWarn ? "warn" : "ok"),
  };
}

export function useHealthData() {
  return useQuery<HealthData>({
    queryKey: ["health", "data"],
    queryFn: async () => {
      const raw = await apiFetch<HealthData>({ path: "/health/data" });
      return normalizeHealthPayload(raw ?? {});
    },
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: 1,
  });
}

export function HealthBanner() {
  const { data } = useHealthData();
  const [dismissed, setDismissed] = useState<string[]>([]);
  const warnings = (data?.warnings ?? []).filter((w) => !dismissed.includes(w.message));
  if (warnings.length === 0) return null;
  return (
    <div className="border-b border-warning/30 bg-warning/8">
      {warnings.map((w, i) => (
        <div
          key={i}
          className="flex items-start gap-2 px-3 py-1.5 text-xs border-b border-warning/15 last:border-0"
        >
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 text-warning shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="font-semibold text-warning uppercase tracking-wider text-[10px] mr-2">
              {w.level ?? "warn"}
              {w.source ? ` · ${w.source}` : ""}
            </span>
            <span className="text-foreground/90">{w.message}</span>
          </div>
          <Link
            to="/health"
            className="text-[11px] text-warning hover:underline inline-flex items-center gap-1"
          >
            Ver <ExternalLink className="h-3 w-3" />
          </Link>
          <button
            onClick={() => setDismissed((d) => [...d, w.message])}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Listens for 401 from apiFetch and redirects to /settings with a clear message. */
export function UnauthorizedGuard() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  useEffect(() => {
    const onUnauth = (e: Event) => {
      const detail = (e as CustomEvent).detail as ApiError["payload"] | undefined;
      if (pathname === "/settings") return;
      const msg = detail?.message || "API Key inválida ou ausente.";
      sessionStorage.setItem("urano.auth.msg", msg);
      navigate({ to: "/settings" });
    };
    window.addEventListener("urano:unauthorized", onUnauth);
    return () => window.removeEventListener("urano:unauthorized", onUnauth);
  }, [navigate, pathname]);
  return null;
}
