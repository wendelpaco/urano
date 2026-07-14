import { createFileRoute, Link } from "@tanstack/react-router";
import { asArray, useWallet } from "@/lib/queries";
import { apiFetch } from "@/lib/api";
import { MetricCard, Panel, PanelHeader, SectionHeader } from "@/components/app/primitives";
import { LoadingState, ErrorState, EmptyState } from "@/components/app/states";
import { DeltaPill, ScoreBadge, SectorBadge, TickerBadge } from "@/components/app/badges";
import { fmtBRL, fmtPct } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from "recharts";
import { useMemo } from "react";

export const Route = createFileRoute("/portfolio/$id")({
  head: ({ params }) => ({ meta: [{ title: `Carteira ${params.id}` }] }),
  component: WalletDetail,
});

const CHART_COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
];

function WalletDetail() {
  const { id } = Route.useParams();
  const q = useWallet(id);
  const w: any = q.data ?? {};
  const positions = asArray(w.positions ?? w.assets);

  const rebalance = useMutation({
    mutationFn: () => apiFetch({ path: `/wallets/${id}/rebalance`, method: "POST" }),
    onSuccess: () => {
      toast.success("Sugestão de rebalanceamento gerada");
      q.refetch();
    },
    onError: (e: any) => toast.error(e.message ?? "Falha ao rebalancear"),
  });

  const sectors = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of positions) {
      const s = p.sector ?? "Outros";
      map.set(s, (map.get(s) ?? 0) + Number(p.value ?? p.total ?? 0));
    }
    return Array.from(map, ([name, value]) => ({ name, value }));
  }, [positions]);

  return (
    <div className="p-3 md:p-4 space-y-3">
      <SectionHeader
        title={w.name ?? `Carteira #${id}`}
        subtitle={w.strategy ?? w.profile ?? "Detalhes da carteira e alocação atual."}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link to="/portfolio">Voltar</Link>
            </Button>
            <Button size="sm" onClick={() => rebalance.mutate()} disabled={rebalance.isPending}>
              <RefreshCw
                className={"h-3.5 w-3.5 mr-1.5 " + (rebalance.isPending ? "animate-spin" : "")}
              />
              Rebalancear
            </Button>
          </div>
        }
      />

      {q.isLoading ? <LoadingState /> : null}
      {q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : null}

      {q.isSuccess ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MetricCard label="Patrimônio" value={fmtBRL(w.value ?? w.total)} />
            <MetricCard
              label="Variação"
              value={fmtPct(w.changePct, true)}
              tone={w.changePct > 0 ? "positive" : w.changePct < 0 ? "negative" : "neutral"}
            />
            <MetricCard label="Ativos" value={positions.length} />
            <MetricCard label="Setores" value={sectors.length} />
          </div>

          <div className="grid grid-cols-12 gap-3">
            <Panel className="col-span-12 xl:col-span-8">
              <PanelHeader title="Composição" />
              {positions.length === 0 ? (
                <EmptyState title="Sem posições" />
              ) : (
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                      <th className="text-left px-3 h-8">Ticker</th>
                      <th className="text-left px-3 h-8">Setor</th>
                      <th className="text-right px-3 h-8">Qtd</th>
                      <th className="text-right px-3 h-8">Preço</th>
                      <th className="text-right px-3 h-8">Valor</th>
                      <th className="text-right px-3 h-8">Peso</th>
                      <th className="text-right px-3 h-8">Var %</th>
                      <th className="text-right px-3 h-8">Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map((p: any) => (
                      <tr key={p.ticker} className="border-b border-border/60 hover:bg-surface-2">
                        <td className="px-3 h-8">
                          <Link
                            to="/research/$type/$ticker"
                            params={{ type: p.type ?? "stock", ticker: p.ticker }}
                          >
                            <TickerBadge ticker={p.ticker} />
                          </Link>
                        </td>
                        <td className="px-3 h-8">
                          <SectorBadge sector={p.sector} />
                        </td>
                        <td className="px-3 h-8 text-right tabular">
                          {p.quantity ?? p.qty ?? "—"}
                        </td>
                        <td className="px-3 h-8 text-right tabular">{fmtBRL(p.price)}</td>
                        <td className="px-3 h-8 text-right tabular">
                          {fmtBRL(p.value ?? p.total)}
                        </td>
                        <td className="px-3 h-8 text-right tabular">{fmtPct(p.weight, true)}</td>
                        <td className="px-3 h-8 text-right">
                          <DeltaPill value={p.changePct} alreadyPct />
                        </td>
                        <td className="px-3 h-8 text-right">
                          <ScoreBadge score={p.score} size="sm" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>

            <div className="col-span-12 xl:col-span-4 space-y-3">
              <Panel>
                <PanelHeader title="Distribuição por setor" />
                {sectors.length === 0 ? (
                  <EmptyState />
                ) : (
                  <div style={{ height: 220 }} className="p-2">
                    <ResponsiveContainer>
                      <PieChart>
                        <Pie
                          data={sectors}
                          dataKey="value"
                          nameKey="name"
                          innerRadius={45}
                          outerRadius={80}
                          strokeWidth={1}
                        >
                          {sectors.map((_, i) => (
                            <Cell
                              key={i}
                              fill={CHART_COLORS[i % CHART_COLORS.length]}
                              stroke="var(--color-surface)"
                            />
                          ))}
                        </Pie>
                        <Tooltip
                          formatter={(v: any) => fmtBRL(Number(v))}
                          contentStyle={{
                            background: "var(--color-popover)",
                            border: "1px solid var(--color-border)",
                            borderRadius: 6,
                            fontSize: 12,
                          }}
                        />
                        <Legend wrapperStyle={{ fontSize: 10 }} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </Panel>

              {rebalance.data ? (
                <Panel>
                  <PanelHeader title="Sugestão de rebalanceamento" />
                  <pre className="p-3 text-[11px] font-mono text-muted-foreground overflow-auto max-h-80">
                    {JSON.stringify(rebalance.data, null, 2)}
                  </pre>
                </Panel>
              ) : null}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
