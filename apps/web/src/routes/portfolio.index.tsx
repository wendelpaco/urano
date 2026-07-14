import { createFileRoute, Link } from "@tanstack/react-router";
import { asArray, useWallets } from "@/lib/queries";
import { Panel, PanelHeader, SectionHeader, MetricCard } from "@/components/app/primitives";
import { LoadingState, ErrorState, EmptyState } from "@/components/app/states";
import { fmtBRL, fmtPct } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { LineChart as LineChartIcon, Wallet } from "lucide-react";

export const Route = createFileRoute("/portfolio/")({
  head: () => ({ meta: [{ title: "Carteiras — Portfolio" }] }),
  component: PortfolioIndex,
});

function PortfolioIndex() {
  const q = useWallets();
  const wallets = asArray(q.data);
  const total = wallets.reduce((acc: number, w: any) => acc + Number(w.value ?? w.total ?? 0), 0);
  const avgChange = wallets.length
    ? wallets.reduce((a: number, w: any) => a + Number(w.changePct ?? 0), 0) / wallets.length
    : 0;

  return (
    <div className="p-3 md:p-4 space-y-3">
      <SectionHeader
        title="Portfolio"
        subtitle="Suas carteiras, distribuição e performance."
        actions={
          <Button asChild size="sm" variant="outline">
            <Link to="/portfolio/contribution">
              <LineChartIcon className="h-3.5 w-3.5 mr-1.5" /> Simular aporte
            </Link>
          </Button>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricCard label="Carteiras" value={wallets.length} />
        <MetricCard label="Patrimônio total" value={fmtBRL(total)} />
        <MetricCard label="Variação média" value={fmtPct(avgChange, true)} tone={avgChange > 0 ? "positive" : avgChange < 0 ? "negative" : "neutral"} />
        <MetricCard label="Ativos consolidados" value={wallets.reduce((a: number, w: any) => a + (asArray(w.positions).length ?? 0), 0)} />
      </div>

      <Panel>
        <PanelHeader title="Suas carteiras" />
        {q.isLoading ? <LoadingState /> : null}
        {q.isError ? <div className="p-3"><ErrorState error={q.error} onRetry={() => q.refetch()} /></div> : null}
        {q.isSuccess && wallets.length === 0 ? (
          <EmptyState
            icon={<Wallet className="h-8 w-8" />}
            title="Nenhuma carteira ainda"
            description="Crie sua primeira carteira via API do backend."
          />
        ) : null}
        {wallets.length > 0 ? (
          <div className="divide-y divide-border">
            {wallets.map((w: any) => (
              <Link
                key={w.id}
                to="/portfolio/$id"
                params={{ id: String(w.id) }}
                className="grid grid-cols-12 items-center gap-3 px-3 py-3 hover:bg-surface-2 transition-colors"
              >
                <div className="col-span-4 flex items-center gap-2 min-w-0">
                  <Wallet className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-sm font-medium truncate">{w.name ?? `Carteira #${w.id}`}</span>
                </div>
                <div className="col-span-2 text-xs text-muted-foreground tabular">
                  {asArray(w.positions).length} ativos
                </div>
                <div className="col-span-3 text-xs text-muted-foreground tabular truncate">
                  {w.strategy ?? w.profile ?? "—"}
                </div>
                <div className="col-span-2 tabular text-sm text-right">{fmtBRL(w.value ?? w.total)}</div>
                <div className="col-span-1 text-right tabular text-xs">
                  <span className={w.changePct > 0 ? "text-positive" : w.changePct < 0 ? "text-negative" : "text-muted-foreground"}>
                    {fmtPct(w.changePct, true)}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        ) : null}
      </Panel>
    </div>
  );
}
