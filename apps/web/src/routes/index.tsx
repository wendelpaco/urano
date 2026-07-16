import { createFileRoute, Link } from "@tanstack/react-router";
import { Panel, PanelHeader, MetricCard, SectionHeader } from "@/components/app/primitives";
import {
  asAssets,
  asArray,
  useRanking,
  useWallets,
  type Wallet as WalletData,
  type Asset,
} from "@/lib/queries";
import { useHealthData } from "@/components/app/HealthBanner";
import { LoadingState, ErrorState, EmptyState } from "@/components/app/states";
import { DeltaPill, HealthBadge, ScoreBadge, TickerBadge } from "@/components/app/badges";
import { fmtBRL, fmtNum, fmtPct } from "@/lib/format";
import { apiSettings } from "@/lib/api";
import { useEffect, useState } from "react";
import { Activity, ArrowRight, TrendingDown, TrendingUp, Wallet } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [{ title: "Overview — Urano Terminal" }],
  }),
  component: OverviewPage,
});

function OverviewPage() {
  const [configured, setConfigured] = useState(false);
  useEffect(() => {
    setConfigured(apiSettings.isConfigured());
    const upd = () => setConfigured(apiSettings.isConfigured());
    window.addEventListener("urano:settings", upd);
    return () => window.removeEventListener("urano:settings", upd);
  }, []);

  if (!configured) return <NotConfigured />;

  return (
    <div className="p-3 md:p-4 space-y-3">
      <SectionHeader
        title="Overview"
        subtitle={new Date().toLocaleString("pt-BR", {
          dateStyle: "full",
          timeStyle: "short",
        })}
      />
      <MarketSummary />
      <div className="grid grid-cols-12 gap-3">
        <div className="col-span-12 xl:col-span-8 space-y-3">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <TopAssets type="stock" title="Melhores Ações" />
            <TopAssets type="fii" title="Melhores FIIs" />
          </div>
          <RankingResumido />
        </div>
        <div className="col-span-12 xl:col-span-4 space-y-3">
          <DataHealthPanel />
          <WarningsPanel />
          <WalletsPanel />
        </div>
      </div>
    </div>
  );
}

function NotConfigured() {
  return (
    <div className="p-8 grid place-items-center min-h-[60vh]">
      <div className="max-w-md text-center">
        <div className="font-mono text-[10px] tracking-widest text-primary mb-3">
          URANO / TERMINAL
        </div>
        <h1 className="text-2xl font-semibold">Bem-vindo</h1>
        <p className="text-sm text-muted-foreground mt-2">
          Antes de iniciar, configure o endereço da API e sua API Key para conectar o terminal ao
          backend.
        </p>
        <Link
          to="/settings"
          className="mt-6 inline-flex items-center gap-2 rounded border border-primary/40 bg-primary/10 px-4 py-2 text-sm font-medium text-primary hover:bg-primary/20"
        >
          Configurar API <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </div>
  );
}

function MarketSummary() {
  const stocks = useRanking({ type: "stock", limit: 100 });
  const fiis = useRanking({ type: "fii", limit: 100 });

  const s = asAssets(stocks.data);
  const f = asAssets(fiis.data);
  const all = [...s, ...f];
  const withChange = all.filter((a) => typeof a.changePct === "number");
  const avgChange =
    withChange.length > 0
      ? withChange.reduce((acc, a) => acc + (a.changePct ?? 0), 0) / withChange.length
      : null;
  const gainers = withChange.filter((a) => (a.changePct ?? 0) > 0).length;
  const losers = withChange.filter((a) => (a.changePct ?? 0) < 0).length;
  const scored = all.filter((a) => typeof a.score === "number");
  const avgScore =
    scored.length > 0 ? scored.reduce((acc, a) => acc + (a.score ?? 0), 0) / scored.length : null;

  return (
    <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
      <MetricCard
        label="Ações cobertas"
        value={<span className="tabular">{fmtNum(s.length)}</span>}
      />
      <MetricCard
        label="FIIs cobertos"
        value={<span className="tabular">{fmtNum(f.length)}</span>}
      />
      <MetricCard
        label="Variação média"
        value={avgChange !== null ? fmtPct(avgChange) : "—"}
        tone={
          avgChange && avgChange > 0
            ? "positive"
            : avgChange && avgChange < 0
              ? "negative"
              : "neutral"
        }
      />
      <MetricCard
        label="Em alta"
        value={<span className="text-positive tabular">{fmtNum(gainers)}</span>}
        hint={
          <span className="inline-flex items-center gap-1">
            <TrendingUp className="h-3 w-3" />
            hoje
          </span>
        }
      />
      <MetricCard
        label="Em queda"
        value={<span className="text-negative tabular">{fmtNum(losers)}</span>}
        hint={
          <span className="inline-flex items-center gap-1">
            <TrendingDown className="h-3 w-3" />
            hoje
          </span>
        }
      />
      <MetricCard label="Score médio" value={avgScore !== null ? avgScore.toFixed(1) : "—"} />
    </div>
  );
}

function TopAssets({ type, title }: { type: "stock" | "fii"; title: string }) {
  const q = useRanking({ type, limit: 8, sort: "score", order: "desc" });
  const items = asAssets(q.data).slice(0, 8);

  return (
    <Panel>
      <PanelHeader
        title={title}
        actions={
          <Link
            to="/market"
            search={{ type }}
            className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            ver todos <ArrowRight className="h-3 w-3" />
          </Link>
        }
      />
      {q.isLoading ? <LoadingState /> : null}
      {q.isError ? (
        <div className="p-3">
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </div>
      ) : null}
      {q.isSuccess && items.length === 0 ? <EmptyState /> : null}
      {items.length > 0 ? (
        <div className="divide-y divide-border">
          {items.map((a, i) => (
            <Link
              key={a.ticker ?? i}
              to="/research/$type/$ticker"
              params={{ type, ticker: a.ticker }}
              className="flex items-center gap-3 px-3 py-2 hover:bg-surface-2 transition-colors"
            >
              <span className="tabular text-[10px] text-muted-foreground w-4">
                {(i + 1).toString().padStart(2, "0")}
              </span>
              <TickerBadge ticker={a.ticker} />
              <span className="flex-1 truncate text-xs text-muted-foreground">
                {a.name ?? a.sector ?? ""}
              </span>
              <span className="tabular text-xs">{fmtBRL(a.price)}</span>
              <DeltaPill value={a.changePct} alreadyPct />
              <ScoreBadge score={a.score} size="sm" />
            </Link>
          ))}
        </div>
      ) : null}
    </Panel>
  );
}

function RankingResumido() {
  const q = useRanking({ limit: 12, sort: "score", order: "desc" });
  const items = asAssets(q.data).slice(0, 12);
  return (
    <Panel>
      <PanelHeader
        title="Ranking Geral · Top 12"
        actions={
          <Link
            to="/market"
            className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            ranking completo <ArrowRight className="h-3 w-3" />
          </Link>
        }
      />
      {q.isLoading ? <LoadingState /> : null}
      {q.isError ? (
        <div className="p-3">
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </div>
      ) : null}
      {items.length > 0 ? (
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left px-3 h-8">#</th>
              <th className="text-left px-3 h-8">Ticker</th>
              <th className="text-left px-3 h-8">Setor</th>
              <th className="text-right px-3 h-8">Preço</th>
              <th className="text-right px-3 h-8">Var %</th>
              <th className="text-right px-3 h-8">DY</th>
              <th className="text-right px-3 h-8">P/L</th>
              <th className="text-right px-3 h-8">Score</th>
            </tr>
          </thead>
          <tbody>
            {items.map((a, i) => (
              <tr key={a.ticker} className="border-b border-border/60 hover:bg-surface-2">
                <td className="px-3 h-8 tabular text-muted-foreground">{i + 1}</td>
                <td className="px-3 h-8">
                  <Link
                    to="/research/$type/$ticker"
                    params={{ type: a.type ?? "stock", ticker: a.ticker }}
                  >
                    <TickerBadge ticker={a.ticker} />
                  </Link>
                </td>
                <td className="px-3 h-8 text-xs text-muted-foreground truncate max-w-[160px]">
                  {a.sector ?? "—"}
                </td>
                <td className="px-3 h-8 text-right tabular">{fmtBRL(a.price)}</td>
                <td className="px-3 h-8 text-right">
                  <DeltaPill value={a.changePct} alreadyPct />
                </td>
                <td className="px-3 h-8 text-right tabular">{fmtPct(a.dy, true)}</td>
                <td className="px-3 h-8 text-right tabular">{fmtNum(a.pe)}</td>
                <td className="px-3 h-8 text-right">
                  <ScoreBadge score={a.score} size="sm" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </Panel>
  );
}

function DataHealthPanel() {
  const h = useHealthData();
  const sources = h.data?.sources ?? [];
  return (
    <Panel>
      <PanelHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Activity className="h-3 w-3" /> Data Health
          </span>
        }
        actions={<HealthBadge status={h.data?.status ?? (h.isError ? "error" : "ok")} />}
      />
      <div className="p-3 space-y-1.5">
        {h.isLoading ? <LoadingState /> : null}
        {h.isError ? <ErrorState error={h.error} onRetry={() => h.refetch()} /> : null}
        {sources.length === 0 && h.isSuccess ? <EmptyState title="Sem fontes reportadas" /> : null}
        {sources.map((s) => (
          <div
            key={s.name}
            className="flex items-center justify-between text-xs py-1.5 border-b border-border/50 last:border-0"
          >
            <div className="flex items-center gap-2 min-w-0">
              <HealthBadge status={s.status ?? "ok"} />
              <span className="truncate">{s.name}</span>
            </div>
            <div className="tabular text-muted-foreground text-[11px] shrink-0">
              {typeof s.coverage === "number" ? `${(s.coverage * 100).toFixed(0)}%` : "—"}
              {s.freshness ? ` · ${s.freshness}` : ""}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function WarningsPanel() {
  const h = useHealthData();
  const warnings = h.data?.warnings ?? [];
  return (
    <Panel>
      <PanelHeader
        title="Últimos warnings"
        actions={
          <span className="tabular text-[11px] text-muted-foreground">{warnings.length}</span>
        }
      />
      {warnings.length === 0 ? (
        <EmptyState title="Nenhum warning" description="A qualidade dos dados está estável." />
      ) : (
        <div className="divide-y divide-border">
          {warnings.slice(0, 6).map((w, i) => (
            <div key={i} className="p-3 text-xs">
              <div className="flex items-center gap-2 mb-1">
                <HealthBadge status={w.level === "error" ? "error" : "warn"} />
                {w.source ? <span className="text-muted-foreground">{w.source}</span> : null}
              </div>
              <div className="text-foreground/90">{w.message}</div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function WalletsPanel() {
  const q = useWallets();
  const wallets = asArray<WalletData>(q.data);
  return (
    <Panel>
      <PanelHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Wallet className="h-3 w-3" /> Carteiras
          </span>
        }
        actions={
          <Link to="/portfolio" className="text-[11px] text-muted-foreground hover:text-foreground">
            gerenciar
          </Link>
        }
      />
      {q.isLoading ? <LoadingState /> : null}
      {q.isError ? (
        <div className="p-3">
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </div>
      ) : null}
      {q.isSuccess && wallets.length === 0 ? (
        <EmptyState
          title="Nenhuma carteira"
          description="Crie sua primeira carteira em Portfolio."
        />
      ) : null}
      {wallets.length > 0 ? (
        <div className="divide-y divide-border">
          {wallets.slice(0, 6).map((w) => (
            <Link
              key={w.id ?? w.name}
              to="/portfolio/$id"
              params={{ id: String(w.id) }}
              className="flex items-center justify-between px-3 py-2 hover:bg-surface-2 text-xs"
            >
              <span className="truncate">{w.name ?? `Carteira #${w.id}`}</span>
              <span className="tabular text-muted-foreground">{fmtBRL(w.value ?? w.total)}</span>
            </Link>
          ))}
        </div>
      ) : null}
    </Panel>
  );
}
