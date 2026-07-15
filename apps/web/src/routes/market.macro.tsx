import { createFileRoute } from "@tanstack/react-router";
import { MetricCard, Panel, PanelHeader, SectionHeader } from "@/components/app/primitives";
import { asArray, useMacro, useMacroSeries, type MacroIndicator } from "@/lib/queries";
import { LoadingState, ErrorState, EmptyState } from "@/components/app/states";
import { fmtNum } from "@/lib/format";
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

export const Route = createFileRoute("/market/macro")({
  head: () => ({ meta: [{ title: "Macro" }] }),
  component: MacroPage,
});

function MacroPage() {
  const q = useMacro();
  const indicators = asArray<MacroIndicator>(q.data?.data ?? q.data);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const seriesCode = selected ?? indicators[0]?.code;
  const series = useMacroSeries(seriesCode, 36);

  const history = (series.data?.history ?? []).map((p) => ({
    date: p.date,
    value: p.value,
  }));

  return (
    <div className="p-3 md:p-4 space-y-3">
      <SectionHeader
        title="Macroeconomia"
        subtitle="Indicadores oficiais do Banco Central (SELIC, IPCA, câmbio, PIB). Cache ~1h."
      />

      {q.isLoading ? <LoadingState /> : null}
      {q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : null}

      {q.isSuccess ? (
        <>
          {indicators.length === 0 ? (
            <Panel>
              <EmptyState title="Sem indicadores" description="BCB indisponível ou cache vazio." />
            </Panel>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
              {indicators.map((ind) => {
                const active = ind.code === seriesCode;
                return (
                  <button
                    key={ind.code}
                    type="button"
                    onClick={() => setSelected(ind.code)}
                    className={cn(
                      "text-left rounded-md transition-colors",
                      active ? "ring-1 ring-primary" : "hover:opacity-90",
                    )}
                  >
                    <MetricCard
                      label={ind.name}
                      value={ind.latest ? fmtNum(ind.latest.value) : "—"}
                      tone="neutral"
                    />
                    <div className="px-2 pb-2 text-[10px] text-muted-foreground font-mono -mt-1">
                      {ind.latest?.date ?? "—"}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          <Panel>
            <PanelHeader
              title={
                series.data?.name ?? indicators.find((i) => i.code === seriesCode)?.name ?? "Série"
              }
              actions={
                <span className="text-[11px] font-mono text-muted-foreground">
                  código {seriesCode ?? "—"}
                </span>
              }
            />
            {series.isLoading ? <LoadingState /> : null}
            {series.isError ? (
              <ErrorState error={series.error} onRetry={() => series.refetch()} />
            ) : null}
            {history.length === 0 && series.isSuccess ? (
              <EmptyState title="Sem histórico para esta série" />
            ) : null}
            {history.length > 0 ? (
              <div className="h-64 p-2">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={history}>
                    <defs>
                      <linearGradient id="macroFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--color-chart-1)" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="var(--color-chart-1)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.5} />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 10 }}
                      stroke="var(--muted-foreground)"
                      minTickGap={24}
                    />
                    <YAxis
                      tick={{ fontSize: 10 }}
                      stroke="var(--muted-foreground)"
                      width={48}
                      domain={["auto", "auto"]}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "var(--surface)",
                        border: "1px solid var(--border)",
                        fontSize: 12,
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="value"
                      stroke="var(--color-chart-1)"
                      fill="url(#macroFill)"
                      strokeWidth={1.5}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : null}
          </Panel>
        </>
      ) : null}
    </div>
  );
}
