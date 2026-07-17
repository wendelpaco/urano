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
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BookMarked, Plus, RefreshCw, Save } from "lucide-react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from "recharts";
import { useEffect, useMemo, useState } from "react";
import { addJournalEntry } from "@/lib/journal";

function isFiiTicker(t: string): boolean {
  return /^[A-Z]{4}11$/.test(t.toUpperCase());
}

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

type BuyOnlyRecommendation = {
  ticker: string;
  currentQuantity: number;
  currentPrice: number;
  targetAllocationPercent: number;
  suggestedAction: "BUY" | "HOLD";
  suggestedQuantity: number;
  estimatedCost: number;
};

type RebalanceResult = {
  walletId: string;
  mode: "BUY_ONLY";
  availableAmount: number;
  currentPortfolioValue: number;
  targetPortfolioValue: number;
  totalEstimatedCost: number;
  remainingCash: number;
  executedAt: string;
  recommendations: BuyOnlyRecommendation[];
};

function WalletDetail() {
  const { id } = Route.useParams();
  const qc = useQueryClient();
  const q = useWallet(id);
  const w: Wallet = q.data ?? ({ id: id ?? "" } as Wallet);
  const positions = asArray<Position>(w.positions ?? w.assets);
  const [qtyDraft, setQtyDraft] = useState<Record<string, string>>({});
  const [newTicker, setNewTicker] = useState("");
  const [newQty, setNewQty] = useState("");

  // Sync drafts from server when wallet loads
  useEffect(() => {
    const next: Record<string, string> = {};
    for (const p of positions) {
      const key = String(p.id ?? p.ticker);
      const qv = p.quantity ?? p.qty;
      if (qv != null && Number.isFinite(Number(qv))) next[key] = String(qv);
      else next[key] = "";
    }
    setQtyDraft(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when asset list identity changes
  }, [q.dataUpdatedAt]);

  const currentPositions = positions.flatMap((position) => {
    const key = String(position.id ?? position.ticker);
    const draft = qtyDraft[key];
    const quantity =
      draft !== undefined && draft !== ""
        ? Number(draft.replace(",", "."))
        : Number(position.quantity ?? position.qty);
    return Number.isFinite(quantity) && quantity >= 0
      ? [{ ticker: position.ticker, quantity }]
      : [];
  });
  const hasCompletePositionQuantities =
    positions.length > 0 &&
    positions.every((p) => {
      const key = String(p.id ?? p.ticker);
      const draft = qtyDraft[key];
      const n =
        draft !== undefined && draft !== ""
          ? Number(draft.replace(",", "."))
          : Number(p.quantity ?? p.qty);
      return Number.isFinite(n) && n >= 0;
    });
  const [availableAmount, setAvailableAmount] = useState("1000");

  const saveQty = useMutation({
    mutationFn: async ({ assetId, quantity }: { assetId: string; quantity: number | null }) =>
      apiFetch({
        path: `/wallets/${id}/assets/${assetId}`,
        method: "PATCH",
        body: { quantity },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wallets", id] });
      toast.success("Quantidade salva");
    },
    onError: (e: Error) => toast.error(e.message ?? "Falha ao salvar quantidade"),
  });

  const addAsset = useMutation({
    mutationFn: async () => {
      const ticker = newTicker.trim().toUpperCase();
      if (ticker.length < 5) throw new Error("Ticker inválido (ex.: PETR4, HGLG11).");
      const quantity =
        newQty.trim() === "" ? null : Number(newQty.replace(",", "."));
      if (quantity != null && (!Number.isFinite(quantity) || quantity < 0)) {
        throw new Error("Quantidade inválida.");
      }
      return apiFetch({
        path: `/wallets/${id}/assets`,
        method: "POST",
        body: {
          ticker,
          targetAllocationPercent: 0,
          quantity,
        },
      });
    },
    onSuccess: () => {
      setNewTicker("");
      setNewQty("");
      qc.invalidateQueries({ queryKey: ["wallets", id] });
      toast.success("Ativo adicionado");
    },
    onError: (e: Error) => toast.error(e.message ?? "Falha ao adicionar"),
  });

  const rebalance = useMutation({
    mutationFn: () => {
      if (!hasCompletePositionQuantities) {
        throw new Error(
          "Informe as quantidades reais de todas as posições antes de calcular o aporte.",
        );
      }
      return apiFetch<RebalanceResult>({
        path: `/wallets/${id}/rebalance`,
        method: "POST",
        body: {
          availableAmount: Number(availableAmount),
          currentPositions,
        },
      });
    },
    onSuccess: () => {
      toast.success("Cenário de aporte calculado");
    },
    onError: (e: Error) => toast.error(e.message ?? "Falha ao calcular o aporte"),
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
  const buys = (rb?.recommendations ?? []).filter(
    (item) => item.suggestedAction === "BUY" && item.suggestedQuantity > 0,
  );

  return (
    <div className="p-3 md:p-4 space-y-3">
      <SectionHeader
        title={w.name ?? `Carteira #${id}`}
        subtitle={w.strategy ?? w.profile ?? "Detalhes da carteira e alocação atual."}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link
                to="/portfolio/contribution"
                search={{
                  walletId: id,
                  fromScratch: "0",
                  amount: availableAmount || "1000",
                  profile: "moderado",
                }}
              >
                Simular aporte (qualidade)
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link to="/portfolio">Voltar</Link>
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
              <PanelHeader
                title="Composição / custódia"
                actions={
                  <span className="text-[10px] text-muted-foreground">
                    Quantidade salva no servidor
                  </span>
                }
              />
              {positions.length === 0 ? (
                <EmptyState
                  title="Sem posições"
                  description="Adicione um ticker abaixo para montar a carteira."
                />
              ) : (
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                      <th className="text-left px-3 h-8">Ticker</th>
                      <th className="text-left px-3 h-8">Nome</th>
                      <th className="text-right px-3 h-8">Qtd</th>
                      <th className="text-right px-3 h-8 w-20">Salvar</th>
                      <th className="text-right px-3 h-8">% alvo</th>
                      <th className="text-right px-3 h-8">Preço</th>
                      <th className="text-right px-3 h-8">Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map((p) => {
                      const key = String(p.id ?? p.ticker);
                      const serverQty = p.quantity ?? p.qty;
                      const draft = qtyDraft[key] ?? "";
                      const dirty =
                        (draft === "" && serverQty != null) ||
                        (draft !== "" && Number(draft.replace(",", ".")) !== Number(serverQty));
                      return (
                        <tr key={key} className="border-b border-border/60 hover:bg-surface-2">
                          <td className="px-3 h-10">
                            <Link
                              to="/research/$type/$ticker"
                              params={{
                                type: p.type ?? (isFiiTicker(p.ticker) ? "fii" : "stock"),
                                ticker: p.ticker,
                              }}
                            >
                              <TickerBadge ticker={p.ticker} />
                            </Link>
                          </td>
                          <td className="px-3 h-10 text-xs text-muted-foreground truncate max-w-[140px]">
                            {(p.companyName as string | undefined) ?? p.sector ?? "—"}
                          </td>
                          <td className="px-3 h-10 text-right">
                            <Input
                              value={draft}
                              onChange={(e) =>
                                setQtyDraft((prev) => ({ ...prev, [key]: e.target.value }))
                              }
                              placeholder="0"
                              className="h-7 w-24 ml-auto font-mono text-xs text-right"
                              inputMode="decimal"
                            />
                          </td>
                          <td className="px-3 h-10 text-right">
                            <Button
                              type="button"
                              size="sm"
                              variant={dirty ? "default" : "ghost"}
                              className="h-7 px-2"
                              disabled={!p.id || saveQty.isPending || !dirty}
                              onClick={() => {
                                if (!p.id) {
                                  toast.error("Ativo sem id — recarregue a carteira.");
                                  return;
                                }
                                const raw = qtyDraft[key]?.trim() ?? "";
                                const quantity =
                                  raw === "" ? null : Number(raw.replace(",", "."));
                                if (quantity != null && (!Number.isFinite(quantity) || quantity < 0)) {
                                  toast.error("Quantidade inválida");
                                  return;
                                }
                                saveQty.mutate({ assetId: String(p.id), quantity });
                              }}
                            >
                              <Save className="h-3.5 w-3.5" />
                            </Button>
                          </td>
                          <td className="px-3 h-10 text-right tabular text-muted-foreground">
                            {fmtPct(p.targetAllocationPercent, true)}
                          </td>
                          <td className="px-3 h-10 text-right tabular">{fmtBRL(p.price)}</td>
                          <td className="px-3 h-10 text-right">
                            <ScoreBadge score={p.score} size="sm" />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              <div className="p-3 border-t border-border flex flex-wrap gap-2 items-end">
                <div className="space-y-1">
                  <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Adicionar ticker
                  </Label>
                  <Input
                    value={newTicker}
                    onChange={(e) => setNewTicker(e.target.value.toUpperCase())}
                    placeholder="PETR4"
                    className="h-8 w-28 font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Qtd
                  </Label>
                  <Input
                    value={newQty}
                    onChange={(e) => setNewQty(e.target.value)}
                    placeholder="100"
                    className="h-8 w-24 font-mono"
                    inputMode="decimal"
                  />
                </div>
                <Button
                  type="button"
                  size="sm"
                  className="h-8"
                  disabled={addAsset.isPending}
                  onClick={() => addAsset.mutate()}
                >
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  Incluir
                </Button>
              </div>
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
                <PanelHeader title="Aporte somente-compra" />
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
                    Calcula um cenário buy-only com o caixa informado. Posições acima da meta ficam
                    em HOLD; nenhuma venda é sugerida.
                  </p>
                  {!hasCompletePositionQuantities ? (
                    <p className="text-[11px] text-amber-500/90 leading-relaxed">
                      Esta carteira guarda metas, mas ainda não possui quantidades completas de
                      custódia. O patrimônio considerado usa somente quantidades efetivamente
                      informadas.
                    </p>
                  ) : null}
                  <Button
                    type="submit"
                    size="sm"
                    className="w-full"
                    disabled={rebalance.isPending || !hasCompletePositionQuantities}
                  >
                    <RefreshCw
                      className={
                        "h-3.5 w-3.5 mr-1.5 " + (rebalance.isPending ? "animate-spin" : "")
                      }
                    />
                    {rebalance.isPending
                      ? "Calculando…"
                      : hasCompletePositionQuantities
                        ? "Calcular cenário"
                        : "Quantidades necessárias"}
                  </Button>
                </form>
              </Panel>

              {rebalance.isError ? (
                <ErrorState error={rebalance.error} onRetry={() => rebalance.mutate()} />
              ) : null}

              {rb ? (
                <Panel>
                  <PanelHeader
                    title="Cenário de aporte buy-only"
                    actions={
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 text-[11px]"
                        onClick={() => {
                          const tickers = buys
                            .map((b) => b.ticker)
                            .filter(Boolean)
                            .slice(0, 6)
                            .join(", ");
                          addJournalEntry({
                            kind: "rebalance",
                            title: `Rebalance carteira ${w.name ?? id} · R$ ${availableAmount}${
                              tickers ? ` · ${tickers}` : ""
                            }`,
                            summary: `${buys.length} compra(s) calculada(s), custo ${fmtBRL(
                              rb.totalEstimatedCost,
                            )}`,
                            payload: {
                              walletId: id,
                              params: { availableAmount: Number(availableAmount) },
                              result: rb,
                            },
                          });
                          toast.success("Salvo no journal");
                        }}
                      >
                        <BookMarked className="h-3.5 w-3.5 mr-1" />
                        Salvar no journal
                      </Button>
                    }
                  />
                  <div className="p-3 space-y-3">
                    <div className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
                      <div>
                        Compras:{" "}
                        <span className="font-mono text-foreground">
                          {fmtBRL(rb.totalEstimatedCost)}
                        </span>
                      </div>
                      <div>
                        Caixa restante:{" "}
                        <span className="font-mono text-foreground">
                          {fmtBRL(rb.remainingCash)}
                        </span>
                      </div>
                      <div>
                        Patrimônio considerado:{" "}
                        <span className="font-mono text-foreground">
                          {fmtBRL(rb.currentPortfolioValue)}
                        </span>
                      </div>
                      <div>
                        Patrimônio após aporte:{" "}
                        <span className="font-mono text-foreground">
                          {fmtBRL(rb.targetPortfolioValue)}
                        </span>
                      </div>
                    </div>
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
                              <th className="text-right py-1">Preço</th>
                              <th className="text-right py-1">Valor</th>
                            </tr>
                          </thead>
                          <tbody>
                            {buys.map((b, i) => (
                              <tr key={i} className="border-b border-border/50">
                                <td className="py-1.5">
                                  <TickerBadge ticker={b.ticker} />
                                </td>
                                <td className="py-1.5 text-right tabular">{b.suggestedQuantity}</td>
                                <td className="py-1.5 text-right tabular">
                                  {fmtBRL(b.currentPrice)}
                                </td>
                                <td className="py-1.5 text-right tabular">
                                  {fmtBRL(b.estimatedCost)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <EmptyState title="Nenhuma compra cabe no caixa ou nas metas atuais" />
                    )}
                    <p className="text-[11px] text-amber-500/90">
                      Cenário matemático experimental; não representa recomendação individualizada
                      nem substitui a conferência das posições na corretora.
                    </p>
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
