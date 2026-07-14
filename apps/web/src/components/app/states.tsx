import { cn } from "@/lib/utils";
import { AlertTriangle, Inbox, Loader2, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { Link } from "@tanstack/react-router";

export function LoadingState({ label = "Carregando…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}

export function SkeletonRows({ rows = 8 }: { rows?: number }) {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-3 py-2.5">
          <div className="h-3 w-16 rounded bg-surface-3 animate-pulse" />
          <div className="h-3 flex-1 rounded bg-surface-2 animate-pulse" />
          <div className="h-3 w-20 rounded bg-surface-2 animate-pulse" />
          <div className="h-3 w-16 rounded bg-surface-2 animate-pulse" />
        </div>
      ))}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  const isApi = error instanceof ApiError;
  const status = isApi ? error.status : undefined;
  const title =
    isApi && error.payload.error ? error.payload.error : "Erro ao carregar dados";
  const message =
    (isApi && error.payload.message) ||
    (error instanceof Error ? error.message : "Erro desconhecido");
  const details = isApi ? error.payload.details : undefined;

  return (
    <div
      className={cn(
        "flex flex-col items-start gap-3 rounded-md border border-negative/40 bg-negative/5 p-4",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="h-4 w-4 text-negative mt-0.5" />
        <div>
          <div className="text-sm font-semibold text-foreground">
            {title}
            {status ? (
              <span className="ml-2 tabular text-xs text-muted-foreground">
                [HTTP {status}]
              </span>
            ) : null}
          </div>
          <div className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap">
            {message}
          </div>
          {details ? (
            <pre className="tabular text-[11px] text-muted-foreground mt-2 max-h-40 overflow-auto">
              {typeof details === "string"
                ? details
                : JSON.stringify(details, null, 2)}
            </pre>
          ) : null}
        </div>
      </div>
      <div className="flex gap-2">
        {onRetry ? (
          <Button size="sm" variant="secondary" onClick={onRetry}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Tentar novamente
          </Button>
        ) : null}
        {status === 0 || status === 401 ? (
          <Button size="sm" variant="outline" asChild>
            <Link to="/settings">Abrir Settings</Link>
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function EmptyState({
  title = "Nenhum dado disponível",
  description,
  icon,
  action,
}: {
  title?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center gap-2 py-12 px-6 text-muted-foreground">
      <div className="text-muted-foreground/70">{icon ?? <Inbox className="h-8 w-8" />}</div>
      <div className="text-sm font-medium text-foreground">{title}</div>
      {description ? <div className="text-xs max-w-sm">{description}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
