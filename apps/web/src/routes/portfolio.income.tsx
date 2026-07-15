import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Banknote, Wallet } from "lucide-react";
import { MetricCard, Panel, PanelHeader, SectionHeader } from "@/components/app/primitives";
import { EmptyState, ErrorState, LoadingState } from "@/components/app/states";
import { TickerBadge } from "@/components/app/badges";
import { Button } from "@/components/ui/button";
import { fmtBRL, fmtNum } from "@/lib/format";
import { apiFetch } from "@/lib/api";
import {
  asArray,
  normalizeDividends,
  useWallets,
  type DividendsResponse,
  type Position,
  type Wallet as WalletData,
} from "@/lib/queries";

export const Route = createFileRoute("/portfolio/income")({
  head: () => ({ meta: [{ title: "Proventos — Portfolio" }] }),
  component: PortfolioIncomePage,
});

type Holding = {
  ticker: string;
  type: string;
  quantity: number;
  walletIds: string[];
  walletNames: string[];
};

type TickerIncome = {
  ticker: string;
  type: string;
  quantity: number;
  events: number;
  totalPerShare: number;
  estimatedTotal: number;
  lastDate: string | null;
  monthly: Record<string, number>;
  walletNames: string[];
};

function monthKey(d: string): string {
  return d.slice(0, 7);
}

function PortfolioIncomePage() {
  const walletsQ = useWallets();
  const wallets = asArray<WalletData>(walletsQ.data);

  const holdings = useMemo(() => {
    const map = new Map<string, Holding>();
    for (const w of wallets) {
      const positions = asArray<Position>(w.positions ?? w.assets);
      const wId = String(w.id);
      const wName = w.name ?? `Carteira #${w.id}`;
      for (const p of positions) {
        const ticker = String(p.ticker ?? "")
          .trim()
          .toUpperCase();
        if (!ticker) continue;
        const qty = Number(p.quantity ?? p.qty ?? 0) || 0;
        const type = (p.type as string) || "stock";
        const prev = map.get(ticker);
        if (prev) {
          prev.quantity += qty;
          if (!prev.walletIds.includes(wId)) {
            prev.walletIds.push(wId);
            prev.walletNames.push(wName);
          }
        } else {
          map.set(ticker, {
            ticker,
            type,
            quantity: qty,
            walletIds: [wId],
            walletNames: [wName],
          });
        }
      }
    }
    return Array.from(map.values()).sort((a, b) => a.ticker.localeCompare(b.ticker));
  }, [wallets]);

  const dividendQueries = useQueries({
    queries: holdings.map((h) => ({
      queryKey: ["dividends", h.ticker] as const,
      queryFn: () => apiFetch<DividendsResponse>({ path: `/dividends/${h.ticker}` }),
      enabled: Boolean(h.ticker) && walletsQ.isSuccess,
      staleTime: 5 * 60_000,
      retry: 1,
    })),
  });

  const loadingDivs =
    holdings.length > 0 && dividendQueries.some((q) => q.isLoading || q.isPending);

  const rows: TickerIncome[] = holdings.map((h, i) => {
    const series = normalizeDividends(dividendQueries[i]?.data);
    const monthly: Record<string, number> = {};
    let totalPerShare = 0;
    let lastDate: string | null = null;
    for (const p of series) {
      totalPerShare += p.v;
      const mk = monthKey(p.d);
      monthly[mk] = (monthly[mk] ?? 0) + p.v * h.quantity;
      if (!lastDate || p.d > lastDate) lastDate = p.d;
    }
    return {
      ticker: h.ticker,
      type: h.type,
      quantity: h.quantity,
      events: series.length,
      totalPerShare,
      estimatedTotal: totalPerShare * h.quantity,
      lastDate,
      monthly,
      walletNames: h.walletNames,
    };
  });

  const monthlyHistory = (() => {
    const map = new Map<string, number>();
    for (const r of rows) {
      for (const [m, v] of Object.entries(r.monthly)) {
        map.set(m, (map.get(m) ?? 0) + v);
      }
    }
    return Array.from(map.entries())
      .map(([month, value]) => ({ month, value }))
      .sort((a, b) => a.month.localeCompare(b.month))
      .slice(-24);
  })();

  const totalEstimated = rows.reduce((a, r) => a + r.estimatedTotal, 0);
  const totalEvents = rows.reduce((a, r) => a + r.events, 0);
  const last12 = monthlyHistory.slice(-12).reduce((a, m) => a + m.value, 0);

  return (
    <div className="p-3 md:p-4 space-y-3">
      <SectionHeader
        title="Proventos / Renda"
        subtitle="Histórico de dividendos e proventos das posições nas suas carteiras."
        actions={
          <Button asChild size="sm" variant="outline">
            <Link to="/portfolio">Ver carteiras</Link>
          </Button>
        }
      />

      {walletsQ.isLoading ? <LoadingState /> : null}
      {walletsQ.isError ? (
        <ErrorState error={walletsQ.error} onRetry={() => walletsQ.refetch()} />
      ) : null}

      {walletsQ.isSuccess && wallets.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<Wallet className="h-8 w-8" />}
            title="Nenhuma carteira"
            description="Crie carteiras e adicione posições para ver proventos agregados."
          />
        </Panel>
      ) : null}

      {walletsQ.isSuccess && wallets.length > 0 && holdings.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<Banknote className="h-8 w-8" />}
            title="Sem posições"
            description="Suas carteiras ainda não têm ativos. Abra uma carteira e adicione tickers."
          />
        </Panel>
      ) : null}

      {walletsQ.isSuccess && holdings.length > 0 ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MetricCard label="Ativos com posição" value={holdings.length} />
            <MetricCard label="Eventos de provento" value={totalEvents} />
            <MetricCard label="Histórico estimado (qtd × valor)" value={fmtBRL(totalEstimated)} />
            <MetricCard label="Últimos 12 meses (est.)" value={fmtBRL(last12)} />
          </div>

          <div className="grid grid-cols-12 gap-3">
            <Panel className="col-span-12 xl:col-span-7">
              <PanelHeader title="Histórico mensal estimado" />
              {loadingDivs ? (
                <LoadingState label="Carregando proventos…" />
              ) : monthlyHistory.length === 0 ? (
                <EmptyState
                  title="Sem dados de proventos"
                  description="A API não retornou histórico para os tickers das carteiras (ou a API não está configurada)."
                />
              ) : (
                <div style={{ height: 260 }} className="p-2 pr-3">
                  <ResponsiveContainer>
                    <BarChart data={monthlyHistory}>
                      <CartesianGrid
                        strokeDasharray="3 3"
                        stroke="var(--border)"
                        vertical={false}
                      />
                      <XAxis
                        dataKey="month"
                        tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                        tickLine={false}
                        axisLine={false}
                      />
                      <YAxis
                        tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={(v) => fmtNum(v, true)}
                        width={48}
                      />
                      <Tooltip
                        contentStyle={{
                          background: "var(--card)",
                          border: "1px solid var(--border)",
                          borderRadius: 6,
                          fontSize: 12,
                        }}
                        formatter={(v) => [fmtBRL(Number(v)), "Estimado"]}
                      />
                      <Bar dataKey="value" fill="var(--color-chart-1)" radius={[2, 2, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </Panel>

            <Panel className="col-span-12 xl:col-span-5">
              <PanelHeader title="Carteiras" />
              <div className="divide-y divide-border">
                {wallets.map((w) => {
                  const positions = asArray<Position>(w.positions ?? w.assets);
                  return (
                    <Link
                      key={w.id}
                      to="/portfolio/$id"
                      params={{ id: String(w.id) }}
                      className="flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-surface-2 transition-colors"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <Wallet className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <span className="text-sm font-medium truncate">
                          {w.name ?? `Carteira #${w.id}`}
                        </span>
                      </div>
                      <span className="text-xs text-muted-foreground tabular shrink-0">
                        {positions.length} ativos
                      </span>
                    </Link>
                  );
                })}
              </div>
            </Panel>
          </div>

          <Panel>
            <PanelHeader title="Por ativo" />
            {loadingDivs ? (
              <LoadingState label="Carregando proventos por ticker…" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                      <th className="text-left px-3 h-8">Ticker</th>
                      <th className="text-right px-3 h-8">Qtd</th>
                      <th className="text-right px-3 h-8">Eventos</th>
                      <th className="text-right px-3 h-8">Por ação (Σ)</th>
                      <th className="text-right px-3 h-8">Estimado</th>
                      <th className="text-right px-3 h-8">Último</th>
                      <th className="text-left px-3 h-8">Carteiras</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.ticker} className="border-b border-border/60 hover:bg-surface-2">
                        <td className="px-3 h-9">
                          <Link
                            to="/research/$type/$ticker"
                            params={{
                              type: r.type === "fii" ? "fii" : "stock",
                              ticker: r.ticker,
                            }}
                          >
                            <TickerBadge ticker={r.ticker} />
                          </Link>
                        </td>
                        <td className="px-3 h-9 text-right tabular">{fmtNum(r.quantity)}</td>
                        <td className="px-3 h-9 text-right tabular">{r.events || "—"}</td>
                        <td className="px-3 h-9 text-right tabular">
                          {r.events ? fmtBRL(r.totalPerShare) : "—"}
                        </td>
                        <td className="px-3 h-9 text-right tabular font-medium">
                          {r.events ? fmtBRL(r.estimatedTotal) : "—"}
                        </td>
                        <td className="px-3 h-9 text-right tabular text-xs text-muted-foreground">
                          {r.lastDate ?? "—"}
                        </td>
                        <td className="px-3 h-9 text-xs text-muted-foreground truncate max-w-[160px]">
                          {r.walletNames.join(", ")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <p className="text-[11px] text-muted-foreground leading-relaxed px-1">
            Proventos são dados históricos retornados pela API (melhor esforço). O valor estimado
            multiplica o provento por ação pela quantidade nas carteiras — não é rendimento futuro
            nem recomendação de investimento.
          </p>
        </>
      ) : null}
    </div>
  );
}
