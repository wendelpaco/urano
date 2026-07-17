import { createFileRoute, Link } from "@tanstack/react-router";
import {
  useAssetDetail,
  useDividends,
  useHistory,
  useScoreValidation,
  useTechnicalIndicators,
  useStockStats,
  type Asset,
  type AssetDataCoverage,
  type HistoryResponse,
  type DividendsResponse,
  type InvestmentGuidance,
  type SectorPeerSummary,
} from "@/lib/queries";
import {
  MetricCard,
  MetricRow,
  Panel,
  PanelHeader,
  SectionHeader,
} from "@/components/app/primitives";
import { DeltaPill, ScoreBadge, SectorBadge, TickerBadge } from "@/components/app/badges";
import { fmtBRL, fmtNum, fmtPct } from "@/lib/format";
import { ErrorState, LoadingState, EmptyState } from "@/components/app/states";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  BarChart,
  Bar,
} from "recharts";
import {
  CheckCircle2,
  XCircle,
  MinusCircle,
  Sparkles,
  AlertTriangle,
  ShoppingCart,
  Wallet,
  TrendingDown,
  BookOpen,
  ShieldAlert,
} from "lucide-react";

/** Labels legíveis dos campos críticos do score FII (fii-score requiredData). */
const COVERAGE_FIELD_LABELS: Record<string, string> = {
  classification: "Classificação (papel/tijolo)",
  pvp: "P/VP (NAV CVM)",
  liquidity: "Liquidez",
  dividends_history: "Histórico de proventos (≥6 meses com renda)",
  vacancy: "Vacância",
  delinquency: "Inadimplência",
};

function fieldLabel(field: string): string {
  return COVERAGE_FIELD_LABELS[field] ?? field.replace(/_/g, " ");
}

export const Route = createFileRoute("/research/$type/$ticker")({
  head: ({ params }) => ({
    meta: [{ title: `${params.ticker} — Research` }],
  }),
  component: ResearchPage,
});

function getScore(d: Asset | undefined): number | null {
  if (!d) return null;
  return (d.score ?? d.overallScore ?? d.pontuacao ?? d.pontos ?? null) as number | null;
}

function getPillars(d: Asset | undefined): Array<{ name: string; score: number; weight?: number }> {
  if (!d) return [];
  const raw = d.pillars ?? d.pilares ?? d.scores ?? [];
  if (Array.isArray(raw)) return raw as Array<{ name: string; score: number; weight?: number }>;
  return Object.entries(raw as Record<string, unknown>).map(([name, v]) => ({
    name,
    score: (typeof v === "number" ? v : (v as Record<string, unknown>).score) as number,
    weight:
      typeof v === "object"
        ? ((v as Record<string, unknown>).weight as number | undefined)
        : undefined,
  }));
}

function getReasons(d: Asset | undefined): Array<{ kind: "pro" | "con" | "info"; text: string }> {
  if (!d) return [];
  const raw = d.reasons ?? d.motivos ?? [];
  if (!Array.isArray(raw)) return [];
  return raw.map((r: unknown) => {
    if (typeof r === "string") return { kind: "info" as const, text: r };
    const rec = r as Record<string, unknown>;
    const kind = (rec.kind ??
      rec.type ??
      (rec.positive ? "pro" : rec.negative ? "con" : "info")) as string;
    return {
      kind: (kind === "positive" ? "pro" : kind === "negative" ? "con" : kind) as
        "pro" | "con" | "info",
      text: (rec.text ?? rec.message ?? rec.reason ?? "") as string,
    };
  });
}

function ResearchPage() {
  const { type, ticker } = Route.useParams();
  const t = (type as "stock" | "fii") ?? "stock";
  const detail = useAssetDetail(t, ticker);
  const history = useHistory(ticker);
  const dividends = useDividends(ticker);

  const data: Asset = detail.data ?? ({ ticker } as Asset);
  const score = getScore(data);
  const pillars = getPillars(data);
  const reasons = getReasons(data);

  const priceSeries = normalizeSeries(history.data);
  const divSeries = normalizeDividends(dividends.data);

  return (
    <div className="p-3 md:p-4 space-y-3">
      <SectionHeader
        title={
          <div className="flex items-center gap-3">
            <TickerBadge ticker={ticker} className="text-sm py-1 px-2" />
            <span className="text-base font-normal text-muted-foreground truncate max-w-[400px]">
              {data.name ?? data.companyName ?? ""}
            </span>
            <SectorBadge sector={data.sector} />
            <span className="uppercase tracking-widest text-[10px] rounded px-1.5 py-0.5 border border-border text-muted-foreground">
              {t === "fii" ? "FII" : "Ação"}
            </span>
          </div>
        }
        subtitle={data.description ?? undefined}
        actions={
          <div className="flex gap-2">
            <Link
              to="/portfolio/contribution"
              search={{
                fromScratch: "1",
                profile: "moderado",
                onlyTypes: t === "fii" ? "fii" : "all",
                amount: "3000",
              }}
              className="inline-flex items-center gap-1.5 rounded border border-primary/40 bg-primary/10 h-8 px-3 text-xs text-primary hover:bg-primary/20"
            >
              <Sparkles className="h-3.5 w-3.5" /> Simular aporte
            </Link>
            <Link
              to="/market/compare"
              className="inline-flex items-center gap-1.5 rounded border border-border h-8 px-3 text-xs text-muted-foreground hover:bg-surface-2"
            >
              Comparar
            </Link>
            <Link
              to="/ai"
              className="inline-flex items-center gap-1.5 rounded border border-border h-8 px-3 text-xs text-muted-foreground hover:bg-surface-2"
            >
              Copilot
            </Link>
          </div>
        }
      />

      {detail.isLoading ? <LoadingState /> : null}
      {detail.isError ? <ErrorState error={detail.error} onRetry={() => detail.refetch()} /> : null}

      {detail.isSuccess ? (
        <>
          <GuidancePanel
            guidance={data.guidance}
            score={score}
            ticker={ticker}
            type={t}
            diagnosis={data.diagnosis}
          />

          <ExplainScoreBanner score={score} ticker={ticker} type={t} reasons={reasons} />

          <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
            <MetricCard label="Score" value={<ScoreBadge score={score} size="lg" />} />
            <MetricCard
              label="Preço"
              value={fmtBRL(data.price)}
              hint={<DeltaPill value={data.changePct} alreadyPct />}
            />
            <MetricCard label="DY 12m" value={fmtPct(data.dy, true)} />
            <MetricCard label="P/L" value={fmtNum(data.pe)} />
            <MetricCard label="P/VP" value={fmtNum(data.pvp)} />
            <MetricCard label="ROE" value={fmtPct(data.roe, true)} />
          </div>

          <FundamentalsDensePanel data={data} type={t} />

          {t === "stock" && data.sectorPeers ? (
            <SectorPeersPanel peers={data.sectorPeers} />
          ) : null}

          <div className="grid grid-cols-12 gap-3">
            <div className="col-span-12 xl:col-span-8 space-y-3">
              <Panel>
                <PanelHeader title="Cotação · Histórico" />
                <div className="p-3">
                  {priceSeries.length === 0 ? (
                    <EmptyState title="Sem histórico disponível" />
                  ) : (
                    <div style={{ height: 260 }}>
                      <ResponsiveContainer>
                        <AreaChart data={priceSeries}>
                          <defs>
                            <linearGradient id="gPrice" x1="0" y1="0" x2="0" y2="1">
                              <stop
                                offset="0%"
                                stopColor="var(--color-primary)"
                                stopOpacity={0.35}
                              />
                              <stop
                                offset="100%"
                                stopColor="var(--color-primary)"
                                stopOpacity={0}
                              />
                            </linearGradient>
                          </defs>
                          <CartesianGrid
                            stroke="var(--color-border)"
                            strokeDasharray="2 4"
                            vertical={false}
                          />
                          <XAxis
                            dataKey="d"
                            tick={{ fill: "var(--color-muted-foreground)", fontSize: 10 }}
                            tickLine={false}
                            axisLine={false}
                          />
                          <YAxis
                            tick={{ fill: "var(--color-muted-foreground)", fontSize: 10 }}
                            tickLine={false}
                            axisLine={false}
                            width={40}
                            domain={["auto", "auto"]}
                          />
                          <Tooltip
                            contentStyle={{
                              background: "var(--color-popover)",
                              border: "1px solid var(--color-border)",
                              borderRadius: 6,
                              fontSize: 12,
                            }}
                            labelStyle={{ color: "var(--color-muted-foreground)" }}
                          />
                          <Area
                            type="monotone"
                            dataKey="v"
                            stroke="var(--color-primary)"
                            strokeWidth={1.5}
                            fill="url(#gPrice)"
                            isAnimationActive={false}
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </div>
              </Panel>

              <Panel>
                <PanelHeader title="Pilares de análise" />
                {pillars.length === 0 ? (
                  <EmptyState title="Sem pilares reportados" />
                ) : (
                  <div className="p-3 space-y-2">
                    {pillars.map((p) => (
                      <div key={p.name} className="flex items-center gap-3">
                        <div className="w-40 text-xs text-muted-foreground truncate">{p.name}</div>
                        <div className="flex-1 h-2 rounded bg-surface-3 overflow-hidden">
                          <div
                            className={
                              "h-full " +
                              (p.score >= 70
                                ? "bg-positive"
                                : p.score >= 50
                                  ? "bg-warning"
                                  : "bg-negative")
                            }
                            style={{ width: `${Math.min(100, Math.max(0, p.score))}%` }}
                          />
                        </div>
                        <ScoreBadge score={p.score} size="sm" />
                      </div>
                    ))}
                  </div>
                )}
              </Panel>

              <Panel>
                <PanelHeader title="Dividendos" />
                {divSeries.length === 0 ? (
                  <EmptyState title="Sem histórico de proventos" />
                ) : (
                  <div className="p-3" style={{ height: 200 }}>
                    <ResponsiveContainer>
                      <BarChart data={divSeries}>
                        <CartesianGrid
                          stroke="var(--color-border)"
                          strokeDasharray="2 4"
                          vertical={false}
                        />
                        <XAxis
                          dataKey="d"
                          tick={{ fill: "var(--color-muted-foreground)", fontSize: 10 }}
                          tickLine={false}
                          axisLine={false}
                        />
                        <YAxis
                          tick={{ fill: "var(--color-muted-foreground)", fontSize: 10 }}
                          tickLine={false}
                          axisLine={false}
                          width={40}
                        />
                        <Tooltip
                          contentStyle={{
                            background: "var(--color-popover)",
                            border: "1px solid var(--color-border)",
                            borderRadius: 6,
                            fontSize: 12,
                          }}
                        />
                        <Bar
                          dataKey="v"
                          fill="var(--color-chart-3)"
                          radius={[2, 2, 0, 0]}
                          isAnimationActive={false}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </Panel>
            </div>

            <div className="col-span-12 xl:col-span-4 space-y-3">
              <DataCoveragePanel coverage={data.dataCoverage} assetType={t} />

              <Panel>
                <PanelHeader title="Reasons" />
                {reasons.length === 0 ? (
                  <EmptyState title="Sem reasons" />
                ) : (
                  <div className="p-3 space-y-2">
                    {reasons.map((r, i) => {
                      const Icon =
                        r.kind === "pro" ? CheckCircle2 : r.kind === "con" ? XCircle : MinusCircle;
                      const cls =
                        r.kind === "pro"
                          ? "text-positive"
                          : r.kind === "con"
                            ? "text-negative"
                            : "text-muted-foreground";
                      return (
                        <div key={i} className="flex items-start gap-2 text-xs">
                          <Icon className={"h-3.5 w-3.5 mt-0.5 shrink-0 " + cls} />
                          <span className="text-foreground/90">{r.text}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Panel>

              <Panel>
                <PanelHeader title="Métricas" />
                <div className="p-3">
                  <MetricRow label="Market Cap" value={fmtBRL(data.marketCap, true)} />
                  <MetricRow label="Liquidez média" value={fmtBRL(data.liquidity, true)} />
                  <MetricRow label="Dividend Yield" value={fmtPct(data.dy, true)} />
                  {/* UX-5: FII não tem P/L, ROE, margens — esconder linhas N/A */}
                  {t === "stock" ? (
                    <>
                      <MetricRow label="P/L" value={fmtNum(data.pe)} />
                      <MetricRow label="ROE" value={fmtPct(data.roe, true)} />
                      <MetricRow label="ROIC" value={fmtPct(data.roic, true)} />
                      <MetricRow label="Margem Líquida" value={fmtPct(data.netMargin, true)} />
                      <MetricRow label="Dívida/PL" value={fmtNum(data.debtEquity)} />
                      <MetricRow label="LPA" value={fmtBRL(data.eps)} />
                      <MetricRow label="VPA" value={fmtBRL(data.bvps)} />
                    </>
                  ) : null}
                  <MetricRow label="P/VP" value={fmtNum(data.pvp)} />
                </div>
              </Panel>

              <TechnicalPanel ticker={ticker} />
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * F4 — checklist "O que falta neste ativo" a partir de dataCoverage do score FII.
 * Ações: sem cobertura estruturada no endpoint — painel informativo breve.
 */
/** Helper: renderiza checklist de cobertura para ações e FIIs (IMP-3r / UX-5). */
function renderCoverageChecklist(
  coverage: AssetDataCoverage,
  knownCritical: string[],
) {
  const missing = coverage.missingFields;
  const complete = coverage.criticalComplete;
  const checklist = [
    ...knownCritical.map((field) => ({
      field,
      ok: !missing.includes(field),
    })),
    ...missing.filter((f) => !knownCritical.includes(f)).map((field) => ({ field, ok: false })),
  ];

  return (
    <Panel>
      <PanelHeader
        title="O que falta neste ativo"
        actions={
          <span
            className={
              "text-[11px] font-mono tabular " + (complete ? "text-positive" : "text-warning")
            }
            title={
              coverage.policy
                ? `Política: ${coverage.policy}`
                : "percent = campos críticos disponíveis"
            }
          >
            {Math.round(coverage.percent)}% cobertura
          </span>
        }
      />
      <div className="p-3 space-y-2">
        {!complete ? (
          <div className="flex gap-2 text-[11px] text-warning/90 leading-relaxed">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>
              Dados críticos incompletos — o score aplica pior caso + penalidade (não imputa
              favorável).
            </span>
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            Campos críticos presentes. Score ainda é experimental (ver Validação).
          </p>
        )}
        <ul className="space-y-1.5">
          {checklist.map(({ field, ok }) => (
            <li key={field} className="flex items-start gap-2 text-xs">
              {ok ? (
                <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0 text-positive" />
              ) : (
                <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-negative" />
              )}
              <span className={ok ? "text-muted-foreground" : "text-foreground/90"}>
                {fieldLabel(field)}
                {!ok ? <span className="text-muted-foreground"> — ausente</span> : null}
              </span>
            </li>
          ))}
        </ul>
        {missing.length > 0 ? (
          <p className="text-[10px] font-mono text-muted-foreground pt-1">
            missing: {missing.join(", ")}
          </p>
        ) : null}
      </div>
    </Panel>
  );
}

function DataCoveragePanel({
  coverage,
  assetType,
}: {
  coverage: AssetDataCoverage | undefined;
  assetType: "stock" | "fii";
}) {
  if (assetType === "stock") {
    // IMP-3r: agora ações também têm cobertura estruturada.
    if (!coverage || coverage.missingFields.length === 0) {
      return (
        <Panel>
          <PanelHeader title="O que falta neste ativo" />
          <div className="p-3 text-xs text-muted-foreground leading-relaxed">
            {coverage ? (
              <span>
                Cobertura de dados <span className="text-positive font-mono">{Math.round(coverage.percent)}%</span>{" "}
                — todos os campos críticos presentes.
              </span>
            ) : (
              <span>
                Cobertura de dados não reportada pelo endpoint. Verifique o cache ou o
                contrato em <span className="font-mono">GET /analysis/stocks/:ticker</span>.
              </span>
            )}
          </div>
        </Panel>
      );
    }
    // Stock com campos faltantes: mostra checklist como FII
    const stockCriticalFields = [
      "eps", "shares_outstanding", "pe_ratio", "roe", "gross_margin",
      "dividend_yield", "fco_to_net_income", "debt_to_equity",
      "historical_data", "sector", "momentum",
    ];
    return renderCoverageChecklist(coverage, stockCriticalFields);
  }

  if (!coverage) {
    return (
      <Panel>
        <PanelHeader title="O que falta neste ativo" />
        <div className="p-3 text-xs text-muted-foreground leading-relaxed">
          Endpoint não retornou <span className="font-mono">dataCoverage</span>. Se o score FII
          estiver desatualizado no cache, reabra a página ou confira o contrato em{" "}
          <span className="font-mono">GET /analysis/fiis/:ticker</span>.
        </div>
      </Panel>
    );
  }

  const fiiCriticalFields = [
    "classification", "pvp", "liquidity", "dividends_history", "vacancy", "delinquency",
  ];
  return renderCoverageChecklist(coverage, fiiCriticalFields);
}

function GuidancePanel({
  guidance,
  score,
  ticker,
  type,
  diagnosis,
}: {
  guidance?: InvestmentGuidance;
  score: number | null;
  ticker: string;
  type: "stock" | "fii";
  diagnosis?: string;
}) {
  if (!guidance?.stanceLabel && !guidance?.headline) {
    return (
      <Panel>
        <PanelHeader title="O que fazer com este ativo?" />
        <div className="p-3 text-xs text-muted-foreground">
          Orientação indisponível para {ticker}. Score: {score ?? "—"}.{" "}
          {diagnosis ?? "Recarregue a análise após o sync de fundamentals."}
        </div>
      </Panel>
    );
  }

  const tone = guidance.stanceTone ?? "muted";
  const toneCls =
    tone === "positive"
      ? "border-positive/40 bg-positive/5"
      : tone === "negative"
        ? "border-negative/40 bg-negative/5"
        : tone === "warning"
          ? "border-warning/40 bg-warning/5"
          : "border-border bg-surface-2/40";
  const badgeCls =
    tone === "positive"
      ? "bg-positive/15 text-positive border-positive/30"
      : tone === "negative"
        ? "bg-negative/15 text-negative border-negative/30"
        : tone === "warning"
          ? "bg-warning/15 text-warning border-warning/30"
          : "bg-muted text-muted-foreground border-border";

  const why = Array.isArray(guidance.why) ? guidance.why : [];
  const risks = Array.isArray(guidance.risks) ? guidance.risks : [];
  const steps = Array.isArray(guidance.nextSteps) ? guidance.nextSteps : [];
  const disclaimers = Array.isArray(guidance.disclaimers) ? guidance.disclaimers : [];

  return (
    <Panel className={toneCls}>
      <PanelHeader
        title="O que fazer com este ativo?"
        actions={
          <span
            className={
              "inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-medium " +
              badgeCls
            }
          >
            {guidance.stanceLabel}
          </span>
        }
      />
      <div className="p-3 space-y-3 text-xs leading-relaxed">
        <p className="text-sm text-foreground font-medium">{guidance.headline}</p>

        {guidance.confidenceNote ? (
          <p className="text-[11px] text-muted-foreground flex items-start gap-1.5">
            <ShieldAlert className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            {guidance.confidenceNote}
            {type === "fii" ? " · FII experimental." : null}
          </p>
        ) : null}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="rounded border border-border/80 bg-background/60 p-3 space-y-1.5">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              <ShoppingCart className="h-3.5 w-3.5" />
              Se você ainda NÃO tem
            </div>
            <p className="text-foreground/90">{guidance.ifNotHolding}</p>
          </div>
          <div className="rounded border border-border/80 bg-background/60 p-3 space-y-1.5">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              <Wallet className="h-3.5 w-3.5" />
              Se você JÁ tem na carteira
            </div>
            <p className="text-foreground/90">{guidance.ifHolding}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {why.length > 0 ? (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-positive mb-1.5 flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" /> Por que
              </div>
              <ul className="list-disc pl-4 space-y-1 text-muted-foreground">
                {why.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {risks.length > 0 ? (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-negative mb-1.5 flex items-center gap-1">
                <TrendingDown className="h-3 w-3" /> Riscos / atenção
              </div>
              <ul className="list-disc pl-4 space-y-1 text-muted-foreground">
                {risks.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        {steps.length > 0 ? (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-primary mb-1.5 flex items-center gap-1">
              <BookOpen className="h-3 w-3" /> Próximos passos (iniciante)
            </div>
            <ol className="list-decimal pl-4 space-y-1 text-muted-foreground">
              {steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          </div>
        ) : null}

        {(guidance.stance === "study_to_buy" ||
          guidance.stance === "accumulate" ||
          guidance.stance === "hold_watch") && (
          <div className="flex flex-wrap gap-2 pt-1 border-t border-border">
            <Link
              to="/portfolio/contribution"
              search={{
                fromScratch: "1",
                profile:
                  guidance.stance === "accumulate" || guidance.stance === "study_to_buy"
                    ? "moderado"
                    : "conservador",
                onlyTypes: type === "fii" ? "fii" : "all",
                amount: "3000",
              }}
              className="inline-flex items-center gap-1.5 rounded border border-primary/40 bg-primary/10 h-8 px-3 text-xs text-primary hover:bg-primary/20"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Simular se este tipo de ativo cabe no aporte
            </Link>
            <Link
              to="/market/screener"
              search={{
                type: type === "fii" ? "fii" : "stock",
                scoreMin: "65",
                sortBy: "score",
                preset: type === "fii" ? "fii_income" : "first_conservative",
              }}
              className="inline-flex items-center gap-1.5 rounded border border-border h-8 px-3 text-xs text-muted-foreground hover:bg-surface-2"
            >
              Ver outros no screener
            </Link>
          </div>
        )}

        {guidance.whenToRevisit ? (
          <p className="text-[11px] text-muted-foreground border-t border-border pt-2">
            <span className="font-medium text-foreground/80">Quando reavaliar: </span>
            {guidance.whenToRevisit}
          </p>
        ) : null}

        {disclaimers.length > 0 ? (
          <p className="text-[10px] text-muted-foreground/80 leading-snug">
            {disclaimers[0]}
          </p>
        ) : null}
      </div>
    </Panel>
  );
}

function SectorPeersPanel({ peers }: { peers: SectorPeerSummary }) {
  const list = Array.isArray(peers.peers) ? peers.peers : [];
  const vs = Array.isArray(peers.vsSector) ? peers.vsSector : [];

  return (
    <Panel>
      <PanelHeader
        title="Vs setor (peers)"
        actions={
          <span className="text-[10px] text-muted-foreground">
            {peers.peerCount ?? 0} peers
            {peers.sector ? ` · ${peers.sector}` : ""}
          </span>
        }
      />
      <div className="p-3 space-y-3 text-xs">
        {peers.summary ? (
          <p className="text-foreground/90 leading-relaxed">{peers.summary}</p>
        ) : null}

        {vs.length > 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
            {vs.map((m) => {
              const tone =
                m.standing === "better"
                  ? "text-positive"
                  : m.standing === "worse"
                    ? "text-negative"
                    : "text-muted-foreground";
              return (
                <div
                  key={m.field ?? m.label}
                  className="rounded border border-border/70 bg-surface-2/40 px-2 py-1.5"
                >
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {m.label}
                  </div>
                  <div className={"font-mono text-sm tabular-nums " + tone}>
                    {fmtNum(m.self ?? null)}
                    <span className="text-muted-foreground text-[10px] ml-1">
                      med {fmtNum(m.sectorMedian ?? null)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}

        {list.length > 0 ? (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
              Peers por score
            </div>
            <div className="flex flex-wrap gap-1.5">
              {list.map((p) => (
                <Link
                  key={p.ticker}
                  to="/research/$type/$ticker"
                  params={{ type: "stock", ticker: p.ticker ?? "" }}
                  className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 hover:bg-surface-2"
                >
                  <TickerBadge ticker={p.ticker ?? "—"} />
                  <ScoreBadge score={p.score} size="sm" />
                </Link>
              ))}
            </div>
          </div>
        ) : (
          <EmptyState title="Sem peers no mesmo setor" />
        )}
      </div>
    </Panel>
  );
}

function FundamentalsDensePanel({ data, type }: { data: Asset; type: "stock" | "fii" }) {
  const snap = data.fundamentus?.snapshot ?? null;
  const ind = (data.indicators ?? {}) as Record<string, unknown>;

  const rows: Array<{ label: string; value: string }> =
    type === "fii"
      ? [
          { label: "DY 12m", value: fmtPct(data.dy, true) },
          { label: "P/VP", value: fmtNum(data.pvp) },
          { label: "Liquidez", value: fmtBRL(data.liquidity, true) },
          { label: "Preço", value: fmtBRL(data.price) },
        ]
      : [
          { label: "P/L", value: fmtNum(num(ind.peRatio) ?? data.pe) },
          { label: "P/VP", value: fmtNum(num(ind.pbRatio) ?? data.pvp) },
          { label: "PSR", value: fmtNum(num(ind.psRatio) ?? num(snap?.psr)) },
          { label: "EV/EBIT", value: fmtNum(num(ind.evEbit) ?? num(snap?.evEbit)) },
          { label: "ROE", value: fmtPct(num(ind.roe) ?? data.roe, true) },
          { label: "ROIC", value: fmtPct(num(ind.roic) ?? data.roic ?? num(snap?.roic), true) },
          { label: "Marg. líquida", value: fmtPct(num(ind.netMargin) ?? data.netMargin, true) },
          { label: "Dív/PL", value: fmtNum(num(ind.debtToEquity) ?? data.debtEquity) },
          { label: "DY", value: fmtPct(num(ind.dividendYield) ?? data.dy, true) },
          { label: "LPA", value: fmtNum(num(ind.eps) ?? data.eps ?? num(snap?.lpa)) },
          { label: "VPA", value: fmtNum(num(ind.bvps) ?? data.bvps ?? num(snap?.vpa)) },
          {
            label: "Liq. 2m (Fund.)",
            value: fmtBRL(num(snap?.avgDailyLiquidity), true),
          },
        ];

  const divergences = data.fundamentus?.divergenceMessages ?? [];

  return (
    <Panel>
      <PanelHeader
        title={type === "fii" ? "Indicadores FII" : "Indicadores fundamentalistas"}
        actions={
          data.fundamentus?.available ? (
            <span className="text-[10px] text-muted-foreground">
              + cross-check Fundamentus
            </span>
          ) : null
        }
      />
      <div className="p-3 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
        {rows.map((r) => (
          <div
            key={r.label}
            className="rounded border border-border/70 bg-surface-2/40 px-2 py-1.5"
          >
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {r.label}
            </div>
            <div className="font-mono text-sm tabular-nums">{r.value}</div>
          </div>
        ))}
      </div>
      {divergences.length > 0 ? (
        <div className="px-3 pb-3 space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-warning flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" /> Divergências CVM vs Fundamentus
          </div>
          <ul className="text-[11px] text-muted-foreground list-disc pl-4">
            {divergences.slice(0, 4).map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </Panel>
  );
}

function ExplainScoreBanner({
  score,
  ticker,
  type,
  reasons,
}: {
  score: number | null;
  ticker: string;
  type: "stock" | "fii";
  reasons: Array<{ kind: string; text: string }>;
}) {
  const validation = useScoreValidation();
  const v = validation.data;
  const pros = reasons.filter((r) => r.kind === "pro").slice(0, 2);
  const cons = reasons.filter((r) => r.kind === "con").slice(0, 2);

  return (
    <Panel>
      <PanelHeader
        title="Como ler este score"
        actions={
          <Link
            to="/validation"
            className="text-[11px] text-primary hover:underline underline-offset-2"
          >
            Ver validação completa
          </Link>
        }
      />
      <div className="p-3 space-y-2 text-xs leading-relaxed text-foreground/90">
        <p>
          <span className="font-mono font-semibold">{ticker}</span> tem score{" "}
          <span className="font-mono font-semibold">{score ?? "—"}</span>
          {type === "fii" ? " (FII — heurística sem o mesmo backtest das ações)." : "."}{" "}
          {v?.verdict === "quality-filter"
            ? "O motor foi validado como filtro de qualidade: score baixo sinaliza fundamentos mais fracos; score alto não garante retorno superior ao mercado."
            : v?.summary
              ? v.summary
              : "Heurística fundamentalista experimental — não use como sinal de timing ou retorno."}
        </p>
        {(pros.length > 0 || cons.length > 0) && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 pt-1">
            {pros.length > 0 ? (
              <div>
                <div className="text-[10px] uppercase tracking-wider text-positive mb-1">
                  Pontos fortes
                </div>
                <ul className="list-disc pl-4 text-muted-foreground space-y-0.5">
                  {pros.map((r, i) => (
                    <li key={i}>{r.text}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {cons.length > 0 ? (
              <div>
                <div className="text-[10px] uppercase tracking-wider text-negative mb-1">
                  Pontos de atenção
                </div>
                <ul className="list-disc pl-4 text-muted-foreground space-y-0.5">
                  {cons.map((r, i) => (
                    <li key={i}>{r.text}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </Panel>
  );
}

function TechnicalPanel({ ticker }: { ticker: string }) {
  const tech = useTechnicalIndicators(ticker);
  const stats = useStockStats(ticker);
  const t = tech.data as Record<string, unknown> | undefined;
  const s = stats.data as Record<string, unknown> | undefined;

  const rsi = (t?.rsi as { value?: number; signal?: string } | undefined) ?? undefined;
  const macd = (t?.macd as { signal?: string; histogram?: number } | undefined) ?? undefined;
  const bb =
    (t?.bollinger as { upper?: number; middle?: number; lower?: number } | undefined) ?? undefined;

  return (
    <Panel>
      <PanelHeader title="Mercado / técnico" />
      {tech.isLoading || stats.isLoading ? (
        <div className="p-3 text-xs text-muted-foreground">Carregando…</div>
      ) : tech.isError && stats.isError ? (
        <EmptyState title="Indicadores indisponíveis" />
      ) : (
        <div className="p-3">
          <MetricRow
            label="RSI"
            value={rsi?.value != null ? `${fmtNum(rsi.value)} (${rsi.signal ?? "—"})` : "—"}
          />
          <MetricRow label="MACD sinal" value={macd?.signal ?? "—"} />
          <MetricRow label="Bollinger mid" value={fmtNum(bb?.middle ?? null)} />
          <MetricRow label="Máx 52s" value={fmtBRL(num(s?.high52w ?? s?.week52High))} />
          <MetricRow label="Mín 52s" value={fmtBRL(num(s?.low52w ?? s?.week52Low))} />
          <MetricRow label="YTD" value={fmtPct(num(s?.ytdReturn ?? s?.ytd), true)} />
          <MetricRow label="Vol. médio" value={fmtBRL(num(s?.avgVolume ?? s?.volume), true)} />
        </div>
      )}
    </Panel>
  );
}

function num(v: unknown): number | null {
  return typeof v === "number" && !Number.isNaN(v) ? v : null;
}

function normalizeSeries(raw: HistoryResponse | undefined): { d: string; v: number }[] {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : (raw.points ?? raw.data ?? raw.items ?? raw.history ?? []);
  if (!Array.isArray(arr)) return [];
  return arr
    .map((p) => ({
      d: (p.date ?? p.d ?? p.time ?? "").toString().slice(0, 10),
      v: Number(p.close ?? p.price ?? p.value ?? p.v),
    }))
    .filter((p) => p.d && !Number.isNaN(p.v));
}

function normalizeDividends(raw: DividendsResponse | undefined): { d: string; v: number }[] {
  if (!raw) return [];
  const arr = Array.isArray(raw)
    ? raw
    : (raw.monthlyHistory ?? raw.data ?? raw.items ?? raw.dividends ?? []);
  if (!Array.isArray(arr)) return [];
  return arr
    .map((p) => ({
      d: (p.date ?? p.paymentDate ?? p.d ?? "").toString().slice(0, 10),
      v: Number(p.value ?? p.amount ?? p.v),
    }))
    .filter((p) => p.d && !Number.isNaN(p.v));
}
