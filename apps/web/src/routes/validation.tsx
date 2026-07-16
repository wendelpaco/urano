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
    blurb:
      "A execução anterior foi invalidada por viés temporal; nenhuma eficácia do score está comprovada até a revalidação ponto no tempo.",
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
              {!v.decisionUseAllowed && v.decisionBlockers.length > 0 ? (
                <div className="rounded border border-amber-500/30 bg-amber-500/10 p-3">
                  <p className="text-xs font-medium text-amber-400 mb-1">
                    Uso em alocação bloqueado
                  </p>
                  <ul className="list-disc pl-4 text-[11px] text-muted-foreground space-y-1">
                    {v.decisionBlockers.map((blocker) => (
                      <li key={blocker}>{blocker}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
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

          {v.ibov?.vsTopN ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MetricCard
                label={`Top ${v.ibov.vsTopN.n} (média a.a.)`}
                value={fmtPct(v.ibov.vsTopN.avgPortfolio, true)}
              />
              <MetricCard
                label="IBOV real (média a.a.)"
                value={v.ibov.vsTopN.avgIbov != null ? fmtPct(v.ibov.vsTopN.avgIbov, true) : "—"}
              />
              <MetricCard
                label="Delta vs IBOV"
                value={
                  v.ibov.vsTopN.deltaAvgPp != null ? fmtPct(v.ibov.vsTopN.deltaAvgPp, true) : "—"
                }
                tone={
                  (v.ibov.vsTopN.deltaAvgPp ?? 0) > 0
                    ? "positive"
                    : (v.ibov.vsTopN.deltaAvgPp ?? 0) < 0
                      ? "negative"
                      : "neutral"
                }
              />
              <MetricCard label="Anos IBOV com dado" value={`${v.ibov.vsTopN.ibovYears}`} />
            </div>
          ) : null}

          {v.ibov?.byYear ? (
            <Panel>
              <PanelHeader
                title="IBOV por ano civil (Yahoo ^BVSP — dados reais)"
                actions={
                  <span className="text-[10px] font-mono text-muted-foreground">
                    asOf {v.ibov.asOf?.slice(0, 19) ?? "—"}
                  </span>
                }
              />
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                    <th className="text-left px-3 h-8">Ano</th>
                    <th className="text-right px-3 h-8">Retorno %</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(v.ibov.byYear)
                    .sort(([a], [b]) => Number(a) - Number(b))
                    .map(([year, ret]) => (
                      <tr key={year} className="border-b border-border/60">
                        <td className="px-3 h-8 font-mono">{year}</td>
                        <td className="px-3 h-8 text-right tabular">
                          {ret == null ? "—" : fmtPct(ret, true)}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
              <p className="p-3 text-[11px] text-muted-foreground">{v.ibov.note}</p>
            </Panel>
          ) : null}

          {v.strategy?.summary ? (
            <Panel>
              <PanelHeader
                title="Estratégia top-N persistida (último backtest)"
                actions={
                  <span className="text-[10px] font-mono text-muted-foreground truncate max-w-[200px]">
                    run {v.strategy.runId.slice(0, 8)}…
                  </span>
                }
              />
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-3">
                <MetricCard
                  label="Avg portfolio"
                  value={
                    v.strategy.summary.avgPortfolio != null
                      ? fmtPct(v.strategy.summary.avgPortfolio, true)
                      : "—"
                  }
                />
                <MetricCard
                  label="Avg universo"
                  value={
                    v.strategy.summary.avgUniverse != null
                      ? fmtPct(v.strategy.summary.avgUniverse, true)
                      : "—"
                  }
                />
                <MetricCard
                  label="Avg IBOV"
                  value={
                    v.strategy.summary.avgIbov != null
                      ? fmtPct(v.strategy.summary.avgIbov, true)
                      : "—"
                  }
                />
                <MetricCard
                  label="Ganha vs IBOV"
                  value={`${v.strategy.summary.winYearsVsIbov}/${v.strategy.summary.ibovYears}`}
                />
              </div>
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                    <th className="text-left px-3 h-8">Ano</th>
                    <th className="text-right px-3 h-8">Top-N</th>
                    <th className="text-right px-3 h-8">Universo</th>
                    <th className="text-right px-3 h-8">IBOV</th>
                  </tr>
                </thead>
                <tbody>
                  {v.strategy.summary.byYear.map((y) => (
                    <tr key={y.year} className="border-b border-border/60">
                      <td className="px-3 h-8 font-mono">{y.year}</td>
                      <td className="px-3 h-8 text-right tabular">
                        {fmtPct(y.portfolioReturn, true)}
                      </td>
                      <td className="px-3 h-8 text-right tabular">
                        {fmtPct(y.universeReturn, true)}
                      </td>
                      <td className="px-3 h-8 text-right tabular">
                        {y.ibovReturn == null ? "—" : fmtPct(y.ibovReturn, true)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          ) : null}

          {v.fiiBacktest ? (
            <Panel>
              <PanelHeader title="Backtest FII — total return real (último run)" />
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-3">
                <MetricCard label="Observações" value={v.fiiBacktest.observations} />
                <MetricCard label="Tickers" value={v.fiiBacktest.tickers} />
                <MetricCard
                  label="Corr DY→TR+1"
                  value={
                    v.fiiBacktest.dyPredictsNext.n > 0
                      ? v.fiiBacktest.dyPredictsNext.correlation.toFixed(3)
                      : "—"
                  }
                />
                <MetricCard label="n pares DY" value={v.fiiBacktest.dyPredictsNext.n} />
              </div>
              <p className="px-3 text-xs text-muted-foreground leading-relaxed">
                {v.fiiBacktest.dyPredictsNext.interpretation}
              </p>
              <table className="w-full text-[12.5px] mt-2">
                <thead>
                  <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                    <th className="text-left px-3 h-8">Ano</th>
                    <th className="text-right px-3 h-8">TR médio</th>
                    <th className="text-right px-3 h-8">Preço</th>
                    <th className="text-right px-3 h-8">Proventos</th>
                    <th className="text-right px-3 h-8">n</th>
                  </tr>
                </thead>
                <tbody>
                  {v.fiiBacktest.byYear.map((y) => (
                    <tr key={y.year} className="border-b border-border/60">
                      <td className="px-3 h-8 font-mono">{y.year}</td>
                      <td className="px-3 h-8 text-right tabular">{fmtPct(y.avgTotal, true)}</td>
                      <td className="px-3 h-8 text-right tabular">{fmtPct(y.avgPrice, true)}</td>
                      <td className="px-3 h-8 text-right tabular">{fmtPct(y.avgDiv, true)}</td>
                      <td className="px-3 h-8 text-right tabular">{y.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="p-3 text-[11px] text-muted-foreground">
                Fontes: Yahoo (cota) + StatusInvest/DB (proventos). Score FII não é ranking
                histórico. A lista usa fundos existentes hoje, omite encerrados e mantém viés de
                sobrevivência; resultados são apenas exploratórios.
              </p>
            </Panel>
          ) : (
            <Panel>
              <PanelHeader title="Backtest FII" />
              <p className="p-3 text-xs text-muted-foreground">
                Ainda sem run. Execute:{" "}
                <code className="font-mono text-foreground">bun run backtest:fii</code>
              </p>
            </Panel>
          )}

          {v.dataPolicy ? (
            <Panel>
              <PanelHeader title="Política de dados (só fontes gratuitas)" />
              <div className="p-3 text-xs space-y-1 text-muted-foreground">
                <div>
                  Fundamentals: <span className="text-foreground">{v.dataPolicy.fundamentals}</span>
                </div>
                <div>
                  Preços: <span className="text-foreground">{v.dataPolicy.prices}</span>
                </div>
                <div>
                  Macro: <span className="text-foreground">{v.dataPolicy.macro}</span>
                </div>
                <div>
                  Proventos: <span className="text-foreground">{v.dataPolicy.dividends}</span>
                </div>
              </div>
            </Panel>
          ) : null}

          {v.topN ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MetricCard
                label={`Top ${v.topN.n} (média a.a.)`}
                value={fmtPct(v.topN.avgPortfolio, true)}
              />
              <MetricCard
                label="Universo coberto (média a.a.)"
                value={fmtPct(v.topN.avgMarket, true)}
              />
              <MetricCard
                label="Anos com vantagem vs universo"
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
                O score é uma heurística experimental; não trate score alto ou baixo como evidência
                de retorno, qualidade comprovada ou timing.
              </li>
              <li>
                A execução anterior foi invalidada; aguarde um backtest com datas de publicação e
                universo histórico antes de comparar faixas do score.
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
