import { useQuery } from "@tanstack/react-query";
import { apiFetch, ApiError } from "@/lib/api";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ExternalLink, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";

export type HealthData = {
  status?: string;
  sources?: Array<{
    name: string;
    status?: string;
    coverage?: number;
    freshness?: string;
    lastUpdate?: string;
  }>;
  warnings?: Array<{
    level?: "warn" | "error" | "info" | string;
    message: string;
    source?: string;
    details?: unknown;
  }>;
};

export function useHealthData() {
  return useQuery<HealthData>({
    queryKey: ["health", "data"],
    queryFn: () => apiFetch<HealthData>({ path: "/health/data" }),
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
