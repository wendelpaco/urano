import { cn } from "@/lib/utils";
import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { fmtPct } from "@/lib/format";

/** F1 — carimbo de confiança em todo ScoreBadge (não é sinal de compra). */
export const SCORE_BADGE_TRUST_TITLE =
  "Score experimental de qualidade — não prediz retorno. Ver Validação.";

/** F3 — rótulo canônico de dividend yield trailing 12 meses. */
export const DY_TTM_LABEL = "DY TTM 12m";

/** F3 — title/tooltip do DY (janela + exclusão de amortização em FII). */
export const DY_TTM_TITLE =
  "Dividend yield trailing 12 meses: soma de proventos de renda no período ÷ preço. Em FIIs, amortização de principal não entra no DY.";

/**
 * Cabeçalho de coluna DY com contexto TTM (F3).
 * Usa os mesmos tokens tipográficos das tabelas de market/portfolio.
 */
export function DyTtmHeader({
  className,
  align = "right",
}: {
  className?: string;
  align?: "left" | "right";
}) {
  return (
    <th
      title={DY_TTM_TITLE}
      className={cn(
        "h-8 px-3 text-[10px] uppercase tracking-wider text-muted-foreground",
        align === "right" ? "text-right" : "text-left",
        className,
      )}
    >
      {DY_TTM_LABEL}
    </th>
  );
}

/**
 * Postura do filtro de qualidade (study_to_buy / avoid_entry / …).
 * Linguagem orientativa — não é ordem de compra/venda.
 */
export function StanceBadge({
  label,
  tone,
  className,
}: {
  label?: string | null;
  tone?: "positive" | "warning" | "negative" | "muted" | string | null;
  className?: string;
}) {
  if (!label) return null;
  const t = tone ?? "muted";
  return (
    <span
      title="Orientação do filtro de qualidade — não é recomendação de investimento."
      className={cn(
        "inline-flex items-center max-w-[11rem] truncate rounded border px-1.5 py-0.5 text-[10px] font-medium leading-tight",
        t === "positive" && "bg-positive/12 text-positive border-positive/30",
        t === "warning" && "bg-warning/12 text-warning border-warning/30",
        t === "negative" && "bg-negative/12 text-negative border-negative/30",
        (t === "muted" || !["positive", "warning", "negative"].includes(t)) &&
          "bg-surface-3 text-muted-foreground border-border",
        className,
      )}
    >
      {label}
    </span>
  );
}

export function ScoreBadge({
  score,
  size = "md",
  title = SCORE_BADGE_TRUST_TITLE,
}: {
  score: number | null | undefined;
  size?: "sm" | "md" | "lg";
  /** Override opcional; default é o carimbo de confiança F1. */
  title?: string;
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
      title={title}
      aria-label={
        s === null
          ? `Score indisponível. ${SCORE_BADGE_TRUST_TITLE}`
          : `Score ${s.toFixed(0)}. ${SCORE_BADGE_TRUST_TITLE}`
      }
      className={cn(
        "inline-flex items-center justify-center rounded font-semibold tabular border cursor-help",
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
