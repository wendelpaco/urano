import { createFileRoute, Link } from "@tanstack/react-router";
import { Panel, PanelHeader, SectionHeader, MetricCard } from "@/components/app/primitives";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useMutation } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { normalizeAllocationAsset } from "@/lib/queries";
import { useState } from "react";
import { ErrorState, EmptyState } from "@/components/app/states";
import { ScoreBadge, TickerBadge } from "@/components/app/badges";
import { fmtBRL, fmtNum, fmtPct } from "@/lib/format";
import { addJournalEntry } from "@/lib/journal";
import { AlertTriangle, BookMarked, PieChart } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/portfolio/allocate")({
  head: () => ({ meta: [{ title: "Alocação modelo" }] }),
  component: AllocatePage,
});

type AllocatedAsset = {
  ticker: string;
  name?: string;
  type?: string;
  assetType?: string;
  score?: number;
  price?: number;
  quantity?: number;
  amount?: number;
  allocationAmount?: number;
  weight?: number;
  allocationPercent?: number;
  sector?: string;
  reason?: string;
};

type AllocationResult = {
  warnings?: string[];
  config?: {
    totalAmount?: number;
    riskProfile?: string;
    stockPercent?: number;
    fiiPercent?: number;
    minScore?: number;
  };
  assets?: AllocatedAsset[];
  summary?: {
    totalAssets?: number;
    stocks?: number;
    fiis?: number;
    totalInvested?: number;
    remainingCash?: number;
    averageScore?: number;
    estimatedAnnualDividend?: number;
    estimatedMonthlyDividend?: number;
    estimatedDividendYield?: number;
  };
};

function AllocatePage() {
  const [totalAmount, setTotalAmount] = useState("10000");
  const [riskProfile, setRiskProfile] = useState("moderado");

  const run = useMutation({
    mutationFn: async () => {
      return apiFetch<AllocationResult>({
        path: "/analysis/allocate",
        method: "POST",
        body: {
          totalAmount: Number(totalAmount),
          riskProfile,
        },
      });
    },
  });

  const result = run.data;
  const assets = (result?.assets ?? []).map((a) =>
    normalizeAllocationAsset(a as unknown as Record<string, unknown>),
  ) as AllocatedAsset[];
  const summary = result?.summary;

  return (
    <div className="p-3 md:p-4 space-y-3">
      <SectionHeader
        title="Alocação modelo"
        subtitle="Cenário experimental. Classes sem dados comparáveis ficam em caixa; o score não está validado para decisão."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to="/validation">Ver validação do score</Link>
          </Button>
        }
      />

      <div className="grid grid-cols-12 gap-3">
        <Panel className="col-span-12 lg:col-span-4 h-fit">
          <PanelHeader title="Parâmetros" />
          <form
            className="p-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              run.mutate();
            }}
          >
            <div className="space-y-1">
              <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Valor total (R$)
              </Label>
              <Input
                value={totalAmount}
                onChange={(e) => setTotalAmount(e.target.value)}
                className="font-mono h-8"
                inputMode="numeric"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Perfil de risco
              </Label>
              <Select value={riskProfile} onValueChange={setRiskProfile}>
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="conservador">Conservador</SelectItem>
                  <SelectItem value="moderado">Moderado</SelectItem>
                  <SelectItem value="agressivo">Agressivo</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              O motor filtra ativos com score mínimo do perfil e diversifica entre ações e FIIs.
              Para aportar sobre carteira existente, use{" "}
              <Link
                to="/portfolio/contribution"
                className="text-primary underline-offset-2 hover:underline"
              >
                Simulador de aporte
              </Link>
              .
            </p>
            <Button type="submit" className="w-full" disabled={run.isPending}>
              <PieChart className="h-3.5 w-3.5 mr-1.5" />
              {run.isPending ? "Montando…" : "Montar carteira"}
            </Button>
          </form>
        </Panel>

        <div className="col-span-12 lg:col-span-8 space-y-3">
          {run.isError ? <ErrorState error={run.error} onRetry={() => run.mutate()} /> : null}
          {!run.data && !run.isPending && !run.isError ? (
            <Panel>
              <EmptyState
                title="Sem carteira modelo"
                description="Defina valor e perfil e clique em Montar carteira."
              />
            </Panel>
          ) : null}

          {result ? (
            <>
              {(result.warnings?.length ?? 0) > 0 ? (
                <Panel>
                  <div className="p-3 flex gap-2 text-xs leading-relaxed text-amber-400">
                    <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                    <ul className="list-disc pl-4 space-y-1">
                      {result.warnings?.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </div>
                </Panel>
              ) : null}
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    addJournalEntry({
                      kind: "allocate",
                      title: `Alocação R$ ${totalAmount} · ${riskProfile}`,
                      summary: `${assets.length} ativos · investido ${fmtBRL(summary?.totalInvested)} · score médio ${
                        summary?.averageScore != null ? fmtNum(summary.averageScore) : "—"
                      }`,
                      payload: {
                        params: {
                          totalAmount: Number(totalAmount),
                          riskProfile,
                        },
                        result,
                      },
                    });
                    toast.success("Salvo no journal");
                  }}
                >
                  <BookMarked className="h-3.5 w-3.5 mr-1.5" />
                  Salvar no journal
                </Button>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <MetricCard label="Investido" value={fmtBRL(summary?.totalInvested)} />
                <MetricCard label="Caixa restante" value={fmtBRL(summary?.remainingCash)} />
                <MetricCard label="Ativos" value={summary?.totalAssets ?? assets.length} />
                <MetricCard
                  label="Score médio"
                  value={summary?.averageScore != null ? fmtNum(summary.averageScore) : "—"}
                />
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <MetricCard
                  label="DY TTM 12m estimado (a.a.)"
                  value={fmtPct(summary?.estimatedDividendYield)}
                />
                <MetricCard
                  label="Proventos / mês (est.)"
                  value={fmtBRL(summary?.estimatedMonthlyDividend)}
                />
                <MetricCard
                  label="Ações / FIIs"
                  value={`${summary?.stocks ?? "—"} / ${summary?.fiis ?? "—"}`}
                />
              </div>

              <Panel>
                <PanelHeader
                  title="Composição sugerida"
                  actions={
                    <span className="tabular text-[11px] text-muted-foreground">
                      {assets.length} ativos
                    </span>
                  }
                />
                {assets.length === 0 ? (
                  <EmptyState title="Nenhum ativo elegível para o perfil" />
                ) : (
                  <table className="w-full text-[12.5px]">
                    <thead>
                      <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                        <th className="text-left px-3 h-8">Ticker</th>
                        <th className="text-left px-3 h-8">Tipo</th>
                        <th className="text-right px-3 h-8">Score</th>
                        <th className="text-right px-3 h-8">Qtd</th>
                        <th className="text-right px-3 h-8">Preço</th>
                        <th className="text-right px-3 h-8">Valor</th>
                        <th className="text-right px-3 h-8">Peso</th>
                      </tr>
                    </thead>
                    <tbody>
                      {assets.map((a) => (
                        <tr key={a.ticker} className="border-b border-border/60 hover:bg-surface-2">
                          <td className="px-3 h-9">
                            <Link
                              to="/research/$type/$ticker"
                              params={{
                                type: a.type === "fii" || a.assetType === "fii" ? "fii" : "stock",
                                ticker: a.ticker,
                              }}
                            >
                              <TickerBadge ticker={a.ticker} />
                            </Link>
                          </td>
                          <td className="px-3 h-9 text-muted-foreground text-xs uppercase">
                            {a.type === "fii"
                              ? "FII"
                              : a.type === "stock"
                                ? "Ação"
                                : (a.type ?? "—")}
                          </td>
                          <td className="px-3 h-9 text-right">
                            {a.score != null ? <ScoreBadge score={a.score} /> : "—"}
                          </td>
                          <td className="px-3 h-9 text-right tabular">{a.quantity ?? "—"}</td>
                          <td className="px-3 h-9 text-right tabular">{fmtBRL(a.price)}</td>
                          <td className="px-3 h-9 text-right tabular">{fmtBRL(a.amount)}</td>
                          <td className="px-3 h-9 text-right tabular">{fmtPct(a.weight, true)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Panel>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
