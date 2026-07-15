import { createFileRoute, Link } from "@tanstack/react-router";
import { asArray, useWallet, type Wallet, type Position } from "@/lib/queries";
import { apiFetch } from "@/lib/api";
import { MetricCard, Panel, PanelHeader, SectionHeader } from "@/components/app/primitives";
import { LoadingState, ErrorState, EmptyState } from "@/components/app/states";
import { DeltaPill, ScoreBadge, SectorBadge, TickerBadge } from "@/components/app/badges";
import { fmtBRL, fmtPct } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from "recharts";
import { useMemo, useState } from "react";

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

type RebalanceBuy = {
  ticker: string;
  quantity?: number;
  qty?: number;
  price?: number;
  total?: number;
  amount?: number;
  reason?: string;
  justification?: string;
};

type RebalanceResult = {
  buys?: RebalanceBuy[];
  purchases?: RebalanceBuy[];
  orders?: RebalanceBuy[];
  sells?: RebalanceBuy[];
  summary?: string;
  message?: string;
  remainingCash?: number;
  warnings?: string[];
  [k: string]: unknown;
};

function WalletDetail() {
  const { id } = Route.useParams();
  const q = useWallet(id);
  const w: Wallet = q.data ?? ({ id: id ?? "" } as Wallet);
  const positions = asArray<Position>(w.positions ?? w.assets);
  const [availableAmount, setAvailableAmount] = useState("1000");

  const rebalance = useMutation({
    mutationFn: () =>
      apiFetch<RebalanceResult>({
        path: `/wallets/${id}/rebalance`,
        method: "POST",
        body: {
          availableAmount: Number(availableAmount),
          currentPositions: positions.map((p) => ({
            ticker: p.ticker,
            quantity: Number(p.quantity ?? p.qty ?? 0),
          })),
        },
      }),
    onSuccess: () => {
      toast.success("Sugestão de rebalanceamento gerada");
    },
    onError: (e: Error) => toast.error(e.message ?? "Falha ao rebalancear"),
  });

  const sectors = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of positions) {
      const s = p.sector ?? "Outros";
      map.set(s, (map.get(s) ?? 0) + Number(p.value ?? p.total ?? 0));
    }
    return Array.from(map, ([name, value]) => ({ name, value }));
  }, [positions]);

  const rb = rebalance.data;
  const buys = asArray<RebalanceBuy>(rb?.buys ?? rb?.purchases ?? rb?.orders);
  const sells = asArray<RebalanceBuy>(rb?.sells);

  return (
    <div className="p-3 md:p-4 space-y-3">
      <SectionHeader
        title={w.name ?? `Carteira #${id}`}
        subtitle={w.strategy ?? w.profile ?? "Detalhes da carteira e alocação atual."}
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to="/portfolio">Voltar</Link>
          </Button>
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
              tone={
                (w.changePct ?? 0) > 0
                  ? "positive"
                  : (w.changePct ?? 0) < 0
                    ? "negative"
                    : "neutral"
              }
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
                    {positions.map((p) => (
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
                          formatter={(v) => fmtBRL(Number(v))}
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

              <Panel>
                <PanelHeader title="Rebalancear" />
                <form
                  className="p-3 space-y-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    rebalance.mutate();
                  }}
                >
                  <div className="space-y-1">
                    <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      Valor disponível (R$)
                    </Label>
                    <Input
                      value={availableAmount}
                      onChange={(e) => setAvailableAmount(e.target.value)}
                      className="font-mono h-8"
                      inputMode="numeric"
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    Gera ordens de compra com o caixa informado, alinhadas ao alvo da carteira e ao
                    filtro de qualidade do score.
                  </p>
                  <Button type="submit" size="sm" className="w-full" disabled={rebalance.isPending}>
                    <RefreshCw
                      className={
                        "h-3.5 w-3.5 mr-1.5 " + (rebalance.isPending ? "animate-spin" : "")
                      }
                    />
                    {rebalance.isPending ? "Calculando…" : "Gerar sugestão"}
                  </Button>
                </form>
              </Panel>

              {rebalance.isError ? (
                <ErrorState error={rebalance.error} onRetry={() => rebalance.mutate()} />
              ) : null}

              {rb ? (
                <Panel>
                  <PanelHeader title="Sugestão de rebalanceamento" />
                  <div className="p-3 space-y-3">
                    {rb.summary || rb.message ? (
                      <p className="text-xs text-foreground/90 whitespace-pre-wrap">
                        {String(rb.summary ?? rb.message)}
                      </p>
                    ) : null}
                    {typeof rb.remainingCash === "number" ? (
                      <div className="text-[11px] text-muted-foreground">
                        Caixa restante:{" "}
                        <span className="font-mono text-foreground">
                          {fmtBRL(rb.remainingCash)}
                        </span>
                      </div>
                    ) : null}
                    {buys.length > 0 ? (
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                          Comprar
                        </div>
                        <table className="w-full text-[12px]">
                          <thead>
                            <tr className="border-b border-border text-[10px] text-muted-foreground">
                              <th className="text-left py-1">Ticker</th>
                              <th className="text-right py-1">Qtd</th>
                              <th className="text-right py-1">Valor</th>
                            </tr>
                          </thead>
                          <tbody>
                            {buys.map((b, i) => (
                              <tr key={i} className="border-b border-border/50">
                                <td className="py-1.5">
                                  <TickerBadge ticker={b.ticker} />
                                </td>
                                <td className="py-1.5 text-right tabular">
                                  {b.quantity ?? b.qty ?? "—"}
                                </td>
                                <td className="py-1.5 text-right tabular">
                                  {fmtBRL(b.total ?? b.amount)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <EmptyState title="Sem compras sugeridas" />
                    )}
                    {sells.length > 0 ? (
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                          Vender / reduzir
                        </div>
                        <div className="space-y-1">
                          {sells.map((s, i) => (
                            <div key={i} className="flex justify-between text-xs">
                              <TickerBadge ticker={s.ticker} />
                              <span className="tabular text-muted-foreground">
                                {s.quantity ?? s.qty ?? "—"}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    {(rb.warnings?.length ?? 0) > 0 ? (
                      <ul className="text-[11px] text-amber-500/90 list-disc pl-4 space-y-0.5">
                        {rb.warnings!.map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                </Panel>
              ) : null}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
