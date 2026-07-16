import { createFileRoute, Link } from "@tanstack/react-router";
import { MetricCard, Panel, PanelHeader, SectionHeader } from "@/components/app/primitives";
import { useBenchmark, useBenchmarks } from "@/lib/queries";
import { LoadingState, ErrorState, EmptyState } from "@/components/app/states";
import { fmtNum, fmtPct } from "@/lib/format";
import { useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/market/benchmarks")({
  head: () => ({ meta: [{ title: "Benchmarks — IBOV" }] }),
  component: BenchmarksPage,
});

function BenchmarksPage() {
  const list = useBenchmarks();
  const items = list.data?.data ?? [];
  const [selected, setSelected] = useState("ibov");
  const [range, setRange] = useState("1y");
  const detail = useBenchmark(selected, range);

  const hist = (
    detail.data?.history as { points?: Array<{ date: string; close: number }> } | undefined
  )?.points;
  const chartData = (hist ?? []).map((p) => ({ date: p.date, close: p.close }));

  return (
    <div className="p-3 md:p-4 space-y-3">
      <SectionHeader
        title="Benchmarks de mercado"
        subtitle="Índices via Yahoo Finance (gratuito). Dados reais de closes — não é feed oficial B3. Use para comparar o score com o mercado."
        actions={
          <Link
            to="/validation"
            className="text-xs text-primary hover:underline underline-offset-2"
          >
            Validação do score
          </Link>
        }
      />

      {list.isLoading ? <LoadingState /> : null}
      {list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : null}

      {list.isSuccess ? (
        <>
          {items.length === 0 ? (
            <EmptyState title="Sem benchmarks" />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {items.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => setSelected(b.id)}
                  className={cn(
                    "text-left rounded-md transition-colors",
                    selected === b.id ? "ring-1 ring-primary" : "hover:opacity-90",
                  )}
                >
                  <MetricCard
                    label={`${b.name} (${b.yahooSymbol})`}
                    value={b.price != null ? fmtNum(b.price) : "—"}
                    hint={
                      b.changePercent != null
                        ? fmtPct(b.changePercent, true)
                        : (b.error ?? "indisponível")
                    }
                    tone={
                      (b.changePercent ?? 0) > 0
                        ? "positive"
                        : (b.changePercent ?? 0) < 0
                          ? "negative"
                          : "neutral"
                    }
                  />
                  <div className="px-3 pb-2 text-[10px] font-mono text-muted-foreground">
                    source={b.source} · asOf={b.asOf?.slice(0, 19) ?? "—"}
                  </div>
                </button>
              ))}
            </div>
          )}

          <Panel>
            <PanelHeader
              title={`Histórico · ${selected.toUpperCase()}`}
              actions={
                <div className="flex gap-1">
                  {(["1mo", "3mo", "1y", "2y", "5y"] as const).map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setRange(r)}
                      className={cn(
                        "text-[10px] font-mono px-1.5 py-0.5 rounded border",
                        range === r
                          ? "border-primary text-primary bg-primary/10"
                          : "border-border text-muted-foreground",
                      )}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              }
            />
            {detail.isLoading ? <LoadingState /> : null}
            {detail.isError ? (
              <ErrorState error={detail.error} onRetry={() => detail.refetch()} />
            ) : null}
            {chartData.length === 0 && detail.isSuccess ? (
              <EmptyState title="Sem pontos de histórico" />
            ) : null}
            {chartData.length > 0 ? (
              <div className="h-72 p-2">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData}>
                    <defs>
                      <linearGradient id="benchFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--color-chart-1)" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="var(--color-chart-1)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.5} />
                    <XAxis dataKey="date" tick={{ fontSize: 10 }} minTickGap={28} />
                    <YAxis tick={{ fontSize: 10 }} width={56} domain={["auto", "auto"]} />
                    <Tooltip
                      contentStyle={{
                        background: "var(--surface)",
                        border: "1px solid var(--border)",
                        fontSize: 12,
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="close"
                      stroke="var(--color-chart-1)"
                      fill="url(#benchFill)"
                      strokeWidth={1.5}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : null}
          </Panel>

          <p className="text-[11px] text-muted-foreground px-1 leading-relaxed">
            {list.data?.note ??
              "Fonte gratuita (Yahoo). Para estatísticas do score vs IBOV, veja Validação."}
          </p>
        </>
      ) : null}
    </div>
  );
}
