import { cn } from "@/lib/utils";
import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { fmtPct } from "@/lib/format";

export function ScoreBadge({
  score,
  size = "md",
}: {
  score: number | null | undefined;
  size?: "sm" | "md" | "lg";
}) {
  const s = typeof score === "number" ? score : null;
  const tone = s === null ? "muted" : s >= 70 ? "positive" : s >= 50 ? "warning" : "negative";
  const sizes = {
    sm: "h-5 min-w-9 text-[11px] px-1.5",
    md: "h-6 min-w-11 text-xs px-2",
    lg: "h-8 min-w-14 text-sm px-2.5",
  }[size];
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded font-semibold tabular border",
        sizes,
        tone === "positive" && "bg-positive/15 text-positive border-positive/30",
        tone === "warning" && "bg-warning/15 text-warning border-warning/30",
        tone === "negative" && "bg-negative/15 text-negative border-negative/30",
        tone === "muted" && "bg-surface-3 text-muted-foreground border-border",
      )}
    >
      {s === null ? "—" : s.toFixed(0)}
    </span>
  );
}

export function TickerBadge({ ticker, className }: { ticker: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold tracking-wide bg-surface-3 text-foreground border border-border",
        className,
      )}
    >
      {ticker}
    </span>
  );
}

export function SectorBadge({ sector }: { sector?: string | null }) {
  if (!sector) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] bg-surface-2 text-muted-foreground border border-border">
      {sector}
    </span>
  );
}

export function DeltaPill({
  value,
  alreadyPct = false,
}: {
  value: number | null | undefined;
  alreadyPct?: boolean;
}) {
  if (value === null || value === undefined || Number.isNaN(value))
    return <span className="tabular text-muted-foreground text-xs">—</span>;
  const tone = value > 0 ? "positive" : value < 0 ? "negative" : "muted";
  const Icon = value > 0 ? ArrowUpRight : value < 0 ? ArrowDownRight : Minus;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 tabular text-xs font-medium",
        tone === "positive" && "text-positive",
        tone === "negative" && "text-negative",
        tone === "muted" && "text-muted-foreground",
      )}
    >
      <Icon className="h-3 w-3" />
      {fmtPct(value, alreadyPct)}
    </span>
  );
}

export function HealthBadge({ status }: { status: "ok" | "warn" | "error" | string }) {
  const map: Record<string, { label: string; cls: string; dot: string }> = {
    ok: {
      label: "OK",
      cls: "bg-positive/10 text-positive border-positive/30",
      dot: "bg-positive",
    },
    warn: {
      label: "WARN",
      cls: "bg-warning/10 text-warning border-warning/30",
      dot: "bg-warning",
    },
    error: {
      label: "ERR",
      cls: "bg-negative/10 text-negative border-negative/30",
      dot: "bg-negative",
    },
  };
  const s = map[status] ?? {
    label: status.toUpperCase(),
    cls: "bg-surface-3 text-muted-foreground border-border",
    dot: "bg-muted-foreground",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wider border",
        s.cls,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", s.dot)} />
      {s.label}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex items-center rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
      {children}
    </kbd>
  );
}
