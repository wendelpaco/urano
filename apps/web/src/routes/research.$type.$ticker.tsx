import { createFileRoute, Link } from "@tanstack/react-router";
import {
  useAssetDetail,
  useDividends,
  useHistory,
  type Asset,
  type HistoryResponse,
  type DividendsResponse,
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
import { CheckCircle2, XCircle, MinusCircle, Sparkles } from "lucide-react";

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
          <Link
            to="/ai"
            className="inline-flex items-center gap-1.5 rounded border border-primary/40 bg-primary/10 h-8 px-3 text-xs text-primary hover:bg-primary/20"
          >
            <Sparkles className="h-3.5 w-3.5" /> Analisar com IA
          </Link>
        }
      />

      {detail.isLoading ? <LoadingState /> : null}
      {detail.isError ? <ErrorState error={detail.error} onRetry={() => detail.refetch()} /> : null}

      {detail.isSuccess ? (
        <>
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
                  <MetricRow label="P/L" value={fmtNum(data.pe)} />
                  <MetricRow label="P/VP" value={fmtNum(data.pvp)} />
                  <MetricRow label="ROE" value={fmtPct(data.roe, true)} />
                  <MetricRow label="ROIC" value={fmtPct(data.roic, true)} />
                  <MetricRow label="Margem Líquida" value={fmtPct(data.netMargin, true)} />
                  <MetricRow label="Dívida/PL" value={fmtNum(data.debtEquity)} />
                  <MetricRow label="LPA" value={fmtBRL(data.eps)} />
                  <MetricRow label="VPA" value={fmtBRL(data.bvps)} />
                </div>
              </Panel>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function normalizeSeries(raw: HistoryResponse | undefined): { d: string; v: number }[] {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : (raw.data ?? raw.items ?? raw.history ?? []);
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
  const arr = Array.isArray(raw) ? raw : (raw.data ?? raw.items ?? raw.dividends ?? []);
  if (!Array.isArray(arr)) return [];
  return arr
    .map((p) => ({
      d: (p.date ?? p.paymentDate ?? p.d ?? "").toString().slice(0, 10),
      v: Number(p.value ?? p.amount ?? p.v),
    }))
    .filter((p) => p.d && !Number.isNaN(p.v));
}
