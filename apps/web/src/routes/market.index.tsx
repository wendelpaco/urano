import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { asAssets, rankingMeta, useRanking } from "@/lib/queries";
import { Panel, PanelHeader, SectionHeader } from "@/components/app/primitives";
import {
  DeltaPill,
  DY_TTM_LABEL,
  DY_TTM_TITLE,
  SCORE_BADGE_TRUST_TITLE,
  ScoreBadge,
  SectorBadge,
  TickerBadge,
} from "@/components/app/badges";
import { fmtBRL, fmtNum, fmtPct } from "@/lib/format";
import { ErrorState, SkeletonRows } from "@/components/app/states";
import { Button } from "@/components/ui/button";
import { Filter } from "lucide-react";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";

const searchSchema = z.object({
  type: fallback(z.enum(["all", "stock", "fii"]), "all").default("all"),
  sort: fallback(z.string(), "score").default("score"),
  order: fallback(z.enum(["asc", "desc"]), "desc").default("desc"),
});

export const Route = createFileRoute("/market/")({
  validateSearch: zodValidator(searchSchema),
  head: () => ({ meta: [{ title: "Ranking — Market" }] }),
  component: RankingPage,
});

function RankingPage() {
  const { type, sort, order } = Route.useSearch();
  const navigate = useNavigate({ from: "/market" });
  // Backend /analysis/ranking only accepts type: stock|fii (no "all") and caps limit at 50 —
  // for "Todos" we fetch both and merge client-side, same pattern as market.search.tsx.
  const stockQ = useRanking({ type: "stock", sort, order, limit: 50 });
  const fiiQ = useRanking({ type: "fii", sort, order, limit: 50 });
  // asAssets normaliza pe/dy/changePct e aceita { data } ou array.
  const stockItems = asAssets(stockQ.data);
  const fiiItems = asAssets(fiiQ.data);
  // "Todos" busca as duas classes separadas (backend não tem type=all) e mescla.
  // Cada lista chega ordenada pelo backend, mas concatenar deixaria todos os FIIs
  // depois de todas as ações — a coluna "#" sugere ranking unificado, então
  // reordenamos client-side pela mesma chave/direção pedida (default: score desc).
  const sortKey = (sort ?? "score") as keyof (typeof stockItems)[number];
  const dir = order === "asc" ? 1 : -1;
  const mergedSorted = [...stockItems, ...fiiItems].sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    const an = typeof av === "number" ? av : Number.NEGATIVE_INFINITY;
    const bn = typeof bv === "number" ? bv : Number.NEGATIVE_INFINITY;
    return (an - bn) * dir;
  });
  const items = type === "all" ? mergedSorted : type === "stock" ? stockItems : fiiItems;
  const meta = rankingMeta(stockQ.data) ?? rankingMeta(fiiQ.data);
  const q =
    type === "all"
      ? {
          isLoading: stockQ.isLoading || fiiQ.isLoading,
          isError: stockQ.isError || fiiQ.isError,
          error: stockQ.error ?? fiiQ.error,
          refetch: () => {
            stockQ.refetch();
            fiiQ.refetch();
          },
        }
      : type === "stock"
        ? stockQ
        : fiiQ;

  const setType = (t: "all" | "stock" | "fii") =>
    navigate({ search: (p: z.infer<typeof searchSchema>) => ({ ...p, type: t }) });
  const setSort = (col: string) =>
    navigate({
      search: (p: z.infer<typeof searchSchema>) => ({
        ...p,
        sort: col,
        order: p.sort === col && p.order === "desc" ? "asc" : "desc",
      }),
    });

  const scoreLabel =
    meta?.scoreVersion != null
      ? `Score ${meta.scoreVersion}${meta.verdict ? ` · ${meta.verdict}` : ""}`
      : null;

  return (
    <div className="p-3 md:p-4 space-y-3">
      <SectionHeader
        title="Ranking"
        subtitle={
          meta
            ? "Ordenado por score de qualidade (não preditor de retorno)."
            : "Ativos ordenados pelo score fundamentalista."
        }
        actions={
          <div className="flex items-center gap-2">
            {scoreLabel ? (
              <Link
                to="/validation"
                className="inline-flex items-center h-7 px-2 rounded border border-primary/30 bg-primary/10 text-[11px] font-semibold text-primary hover:bg-primary/15 transition-colors"
                title="Ver validação do score"
              >
                {scoreLabel}
              </Link>
            ) : null}
            <Button asChild variant="outline" size="sm">
              <Link to="/market/screener">
                <Filter className="h-3.5 w-3.5 mr-1.5" /> Screener avançado
              </Link>
            </Button>
          </div>
        }
      />

      <Panel>
        <PanelHeader
          title={
            <div className="flex items-center gap-1">
              {(["all", "stock", "fii"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setType(t)}
                  className={`px-2 h-6 rounded text-[11px] font-semibold uppercase tracking-wider transition-colors ${
                    type === t
                      ? "bg-primary/15 text-primary border border-primary/30"
                      : "text-muted-foreground hover:text-foreground border border-transparent"
                  }`}
                >
                  {t === "all" ? "Todos" : t === "stock" ? "Ações" : "FIIs"}
                </button>
              ))}
            </div>
          }
          actions={
            <span className="tabular text-[11px] text-muted-foreground">{items.length} ativos</span>
          }
        />
        {q.isLoading ? <SkeletonRows rows={14} /> : null}
        {q.isError ? (
          <div className="p-3">
            <ErrorState error={q.error} onRetry={() => q.refetch()} />
          </div>
        ) : null}
        {items.length > 0 ? (
          <table className="w-full text-[12.5px]">
            <thead className="sticky top-0 bg-surface z-10">
              <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left px-3 h-8 w-10">#</th>
                <SortH
                  label="Ticker"
                  col="ticker"
                  sort={sort}
                  order={order}
                  onClick={setSort}
                  align="left"
                />
                <th className="text-left px-3 h-8">Setor</th>
                <SortH label="Preço" col="price" sort={sort} order={order} onClick={setSort} />
                <SortH label="Var %" col="changePct" sort={sort} order={order} onClick={setSort} />
                {/* TODO(F3): chip DY vs CDI/SELIC quando useMacro tiver série CDI no ranking */}
                <SortH
                  label={DY_TTM_LABEL}
                  col="dy"
                  sort={sort}
                  order={order}
                  onClick={setSort}
                  title={DY_TTM_TITLE}
                />
                <SortH label="P/L" col="pe" sort={sort} order={order} onClick={setSort} />
                <SortH label="P/VP" col="pvp" sort={sort} order={order} onClick={setSort} />
                <SortH label="ROE" col="roe" sort={sort} order={order} onClick={setSort} />
                <SortH
                  label="Score"
                  col="score"
                  sort={sort}
                  order={order}
                  onClick={setSort}
                  title={SCORE_BADGE_TRUST_TITLE}
                />
              </tr>
            </thead>
            <tbody>
              {items.map((a, i) => (
                <tr
                  key={a.ticker ?? i}
                  className="border-b border-border/60 hover:bg-surface-2 cursor-pointer"
                  onClick={() =>
                    navigate({
                      to: "/research/$type/$ticker",
                      params: { type: a.type ?? "stock", ticker: a.ticker },
                    })
                  }
                >
                  <td className="px-3 h-8 tabular text-muted-foreground">{i + 1}</td>
                  <td className="px-3 h-8">
                    <TickerBadge ticker={a.ticker} />
                  </td>
                  <td className="px-3 h-8">
                    <SectorBadge sector={a.sector} />
                  </td>
                  <td className="px-3 h-8 text-right tabular">{fmtBRL(a.price)}</td>
                  <td className="px-3 h-8 text-right">
                    <DeltaPill
                      value={a.changePct ?? (a as { changePercent?: number }).changePercent}
                      alreadyPct
                    />
                  </td>
                  <td className="px-3 h-8 text-right tabular" title={DY_TTM_TITLE}>
                    {fmtPct(a.dy ?? (a as { dividendYield?: number }).dividendYield, true)}
                  </td>
                  <td className="px-3 h-8 text-right tabular">
                    {fmtNum(a.pe ?? (a as { peRatio?: number }).peRatio)}
                  </td>
                  <td className="px-3 h-8 text-right tabular">{fmtNum(a.pvp)}</td>
                  <td className="px-3 h-8 text-right tabular">{fmtPct(a.roe, true)}</td>
                  <td className="px-3 h-8 text-right">
                    <ScoreBadge score={a.score} size="sm" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Panel>
    </div>
  );
}

function SortH({
  label,
  col,
  sort,
  order,
  onClick,
  align = "right",
  title,
}: {
  label: string;
  col: string;
  sort: string;
  order: string;
  onClick: (c: string) => void;
  align?: "left" | "right";
  title?: string;
}) {
  const active = sort === col;
  return (
    <th
      title={title}
      className={`h-8 px-3 select-none cursor-pointer hover:text-foreground ${
        align === "right" ? "text-right" : "text-left"
      } ${active ? "text-foreground" : ""}`}
      onClick={() => onClick(col)}
    >
      {label}
      {active ? <span className="ml-0.5">{order === "desc" ? "↓" : "↑"}</span> : null}
    </th>
  );
}
