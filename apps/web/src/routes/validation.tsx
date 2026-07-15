import { createFileRoute } from "@tanstack/react-router";
import { MetricCard, Panel, PanelHeader, SectionHeader } from "@/components/app/primitives";
import { useScoreValidation } from "@/lib/queries";
import { LoadingState, ErrorState } from "@/components/app/states";
import { fmtNum, fmtPct } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, CheckCircle2, Hourglass } from "lucide-react";

export const Route = createFileRoute("/validation")({
  head: () => ({ meta: [{ title: "Validação do score" }] }),
  component: ValidationPage,
});

const VERDICT_COPY = {
  edge: {
    label: "Edge",
    tone: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    icon: CheckCircle2,
    blurb: "Evidência de que o score ordena retornos acima do mercado na amostra testada.",
  },
  "quality-filter": {
    label: "Filtro de qualidade",
    tone: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    icon: AlertTriangle,
    blurb:
      "O score filtra empresas com fundamentos fracos; não deve ser lido como preditor de retorno superior.",
  },
  pending: {
    label: "Pendente",
    tone: "bg-muted text-muted-foreground border-border",
    icon: Hourglass,
    blurb: "Validação ainda não concluída.",
  },
} as const;

function ValidationPage() {
  const q = useScoreValidation();
  const v = q.data;
  const verdictMeta = v ? VERDICT_COPY[v.verdict] : null;
  const VerdictIcon = verdictMeta?.icon ?? Hourglass;

  return (
    <div className="p-3 md:p-4 space-y-3">
      <SectionHeader
        title="Validação do score"
        subtitle="Etiqueta de confiança do motor — o que o backtest mostrou e o que o produto pode afirmar."
      />

      {q.isLoading ? <LoadingState /> : null}
      {q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : null}

      {v && verdictMeta ? (
        <>
          <Panel>
            <PanelHeader
              title={`Score ${v.scoreVersion}`}
              actions={
                <Badge variant="outline" className={verdictMeta.tone}>
                  <VerdictIcon className="h-3 w-3 mr-1" />
                  {verdictMeta.label}
                </Badge>
              }
            />
            <div className="p-4 space-y-3">
              <p className="text-sm leading-relaxed text-foreground/90">{v.summary}</p>
              <p className="text-xs text-muted-foreground leading-relaxed">{verdictMeta.blurb}</p>
              <div className="flex flex-wrap gap-3 text-[11px] font-mono text-muted-foreground">
                <span>
                  Validado em: <span className="text-foreground">{v.validatedAt ?? "—"}</span>
                </span>
                <span>
                  Anos:{" "}
                  <span className="text-foreground">
                    {v.yearsTested.length ? v.yearsTested.join(", ") : "—"}
                  </span>
                </span>
              </div>
            </div>
          </Panel>

          {v.topN ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MetricCard
                label={`Top ${v.topN.n} (média a.a.)`}
                value={fmtPct(v.topN.avgPortfolio)}
              />
              <MetricCard label="Universo (média a.a.)" value={fmtPct(v.topN.avgMarket)} />
              <MetricCard
                label="Anos com vantagem"
                value={`${v.topN.winYears}/${v.topN.totalYears}`}
              />
              <MetricCard
                label="Delta vs universo"
                value={fmtPct(v.topN.avgPortfolio - v.topN.avgMarket, true)}
                tone={
                  v.topN.avgPortfolio - v.topN.avgMarket > 0
                    ? "positive"
                    : v.topN.avgPortfolio - v.topN.avgMarket < 0
                      ? "negative"
                      : "neutral"
                }
              />
            </div>
          ) : null}

          {v.pillarCorrelations ? (
            <Panel>
              <PanelHeader title="Correlação pilar → retorno 12m" />
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                    <th className="text-left px-3 h-8">Pilar</th>
                    <th className="text-right px-3 h-8">Correlação</th>
                    <th className="text-left px-3 h-8">Leitura</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(v.pillarCorrelations).map(([pillar, corr]) => (
                    <tr key={pillar} className="border-b border-border/60">
                      <td className="px-3 h-9 font-mono text-xs">{pillar}</td>
                      <td className="px-3 h-9 text-right tabular">
                        {corr == null || Number.isNaN(corr)
                          ? "—"
                          : corr.toLocaleString("pt-BR", {
                              minimumFractionDigits: 3,
                              maximumFractionDigits: 3,
                            })}
                      </td>
                      <td className="px-3 h-9 text-xs text-muted-foreground">
                        {Math.abs(corr) < 0.05
                          ? "Ruído / sem sinal útil"
                          : corr > 0
                            ? "Sinal fraco positivo"
                            : "Sinal fraco negativo (mean-reversion?)"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          ) : null}

          <Panel>
            <PanelHeader title="Como usar no produto" />
            <ul className="p-4 text-sm space-y-2 text-foreground/90 list-disc pl-8">
              <li>
                Trate score alto como “fundamentos relativamente melhores no filtro”, não como “vai
                render mais”.
              </li>
              <li>
                Score baixo é o sinal mais útil da validação atual: filtra casos fracos na amostra.
              </li>
              <li>
                Estratégias “compre o top N” não têm evidência robusta o suficiente para serem
                vendidas como edge.
              </li>
              <li>
                FIIs: o score de FII ainda não passou pelo mesmo backtest — use com cautela extra.
              </li>
            </ul>
          </Panel>
        </>
      ) : null}
    </div>
  );
}
