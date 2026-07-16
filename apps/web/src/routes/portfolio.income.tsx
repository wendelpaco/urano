import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Banknote, Wallet } from "lucide-react";
import { MetricCard, Panel, PanelHeader, SectionHeader } from "@/components/app/primitives";
import { EmptyState, ErrorState, LoadingState } from "@/components/app/states";
import { DY_TTM_TITLE, TickerBadge } from "@/components/app/badges";
import { Button } from "@/components/ui/button";
import { fmtBRL, fmtNum, fmtPct } from "@/lib/format";
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
  /** Valor de mercado agregado (qtd × preço ou value da posição), se conhecido. */
  marketValue: number | null;
  walletIds: string[];
  walletNames: string[];
};

type TickerIncome = {
  ticker: string;
  type: string;
  quantity: number;
  marketValue: number | null;
  events: number;
  totalPerShare: number;
  /** Soma de todo o histórico de proventos × qtd atual — NÃO é renda anual. */
  historicalAccumulated: number;
  /** Proventos nos últimos 12 meses de competência × qtd atual. */
  ttmIncome: number;
  lastDate: string | null;
  monthly: Record<string, number>;
  walletNames: string[];
};

function monthKey(d: string): string {
  return d.slice(0, 7);
}

/** Valor de mercado da posição sem inventar preço. */
function positionMarketValue(p: Position, qty: number): number | null {
  const explicit = Number(p.value ?? p.total);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const price = Number(p.price);
  if (Number.isFinite(price) && price > 0 && qty > 0) return price * qty;
  return null;
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
        const mv = positionMarketValue(p, qty);
        const prev = map.get(ticker);
        if (prev) {
          prev.quantity += qty;
          if (mv != null) {
            prev.marketValue = (prev.marketValue ?? 0) + mv;
          }
          if (!prev.walletIds.includes(wId)) {
            prev.walletIds.push(wId);
            prev.walletNames.push(wName);
          }
        } else {
          map.set(ticker, {
            ticker,
            type,
            quantity: qty,
            marketValue: mv,
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

  // Âncora TTM: últimos 12 meses civis a partir do mês atual (UTC).
  const ttmMonthKeys = useMemo(() => {
    const now = new Date();
    const keys: string[] = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
    }
    return new Set(keys);
  }, []);

  const rows: TickerIncome[] = holdings.map((h, i) => {
    const series = normalizeDividends(dividendQueries[i]?.data);
    const monthly: Record<string, number> = {};
    let totalPerShare = 0;
    let ttmPerShare = 0;
    let lastDate: string | null = null;
    for (const p of series) {
      totalPerShare += p.v;
      const mk = monthKey(p.d);
      monthly[mk] = (monthly[mk] ?? 0) + p.v * h.quantity;
      if (ttmMonthKeys.has(mk)) ttmPerShare += p.v;
      if (!lastDate || p.d > lastDate) lastDate = p.d;
    }
    return {
      ticker: h.ticker,
      type: h.type,
      quantity: h.quantity,
      marketValue: h.marketValue,
      events: series.length,
      totalPerShare,
      historicalAccumulated: totalPerShare * h.quantity,
      ttmIncome: ttmPerShare * h.quantity,
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

  const historicalAccumulated = rows.reduce((a, r) => a + r.historicalAccumulated, 0);
  const totalEvents = rows.reduce((a, r) => a + r.events, 0);
  // F6: card primário — renda TTM 12m (não o acumulado de todo o histórico).
  const last12 = rows.reduce((a, r) => a + r.ttmIncome, 0);

  // Yield sobre patrimônio só com valor de mercado conhecido (sem inventar preço).
  const marketValueKnown = rows.reduce(
    (a, r) => a + (r.marketValue != null && r.marketValue > 0 ? r.marketValue : 0),
    0,
  );
  const hasFullMarketValue =
    rows.length > 0 && rows.every((r) => r.marketValue != null && r.marketValue > 0);
  const yieldOnPortfolio =
    hasFullMarketValue && marketValueKnown > 0 ? (last12 / marketValueKnown) * 100 : null;

  return (
    <div className="p-3 md:p-4 space-y-3">
      <SectionHeader
        title="Proventos / Renda"
        subtitle="Renda trailing 12 meses das posições — não use o acumulado histórico como se fosse rendimento anual."
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
            {/* F6 primário: TTM 12m em destaque */}
            <div title={DY_TTM_TITLE} className="col-span-2 md:col-span-1">
              <MetricCard
                label="Renda TTM 12m (est.)"
                value={fmtBRL(last12)}
                hint="Soma dos últimos 12 meses × qtd atual"
                className="ring-1 ring-primary/25"
              />
            </div>
            <MetricCard
              label="Yield s/ patrimônio (TTM)"
              value={yieldOnPortfolio != null ? fmtPct(yieldOnPortfolio, true) : "—"}
              hint={
                yieldOnPortfolio != null
                  ? "last12 ÷ valor de mercado das posições"
                  : "Sem preço/valor em todas as posições"
              }
            />
            <MetricCard label="Ativos com posição" value={holdings.length} />
            <MetricCard
              label="Acumulado histórico (todo o período, não anualizado)"
              value={fmtBRL(historicalAccumulated)}
              hint={`${totalEvents} eventos · não é renda anual`}
            />
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
                      <th className="text-right px-3 h-8" title={DY_TTM_TITLE}>
                        TTM 12m
                      </th>
                      <th
                        className="text-right px-3 h-8"
                        title="Soma de todos os proventos do histórico × qtd atual — não anualizado"
                      >
                        Acumulado histórico
                      </th>
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
                        <td
                          className="px-3 h-9 text-right tabular font-medium"
                          title={DY_TTM_TITLE}
                        >
                          {r.events ? fmtBRL(r.ttmIncome) : "—"}
                        </td>
                        <td
                          className="px-3 h-9 text-right tabular text-muted-foreground"
                          title="Acumulado de todo o período × qtd atual — não é renda anual"
                        >
                          {r.events ? fmtBRL(r.historicalAccumulated) : "—"}
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
            <strong className="text-foreground/80">Renda TTM 12m</strong> é o cartão principal: soma
            proventos dos últimos 12 meses de competência × quantidade atual.{" "}
            <strong className="text-foreground/80">Acumulado histórico</strong> soma todo o
            histórico disponível com a mesma quantidade — não anualize nem trate como renda
            esperada. Yield s/ patrimônio = TTM ÷ valor de mercado só quando preço/valor existe em
            todas as posições. Em FIIs, amortização não deve compor renda/DY (filtro no backend).
            Não é recomendação de investimento.
          </p>
        </>
      ) : null}
    </div>
  );
}
