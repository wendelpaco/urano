import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { asArray, useRanking } from "@/lib/queries";
import { Panel, PanelHeader, SectionHeader } from "@/components/app/primitives";
import { DeltaPill, ScoreBadge, SectorBadge, TickerBadge } from "@/components/app/badges";
import { fmtBRL, fmtNum, fmtPct } from "@/lib/format";
import { LoadingState, ErrorState, SkeletonRows } from "@/components/app/states";
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
  const q = useRanking({ type, sort, order, limit: 200 });
  const items = asArray(q.data);

  const setType = (t: "all" | "stock" | "fii") =>
    navigate({ search: (p: any) => ({ ...p, type: t }) });
  const setSort = (col: string) =>
    navigate({
      search: (p: any) => ({
        ...p,
        sort: col,
        order: p.sort === col && p.order === "desc" ? "asc" : "desc",
      }),
    });

  return (
    <div className="p-3 md:p-4 space-y-3">
      <SectionHeader
        title="Ranking"
        subtitle="Ativos ordenados pelo score fundamentalista."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to="/market/screener">
              <Filter className="h-3.5 w-3.5 mr-1.5" /> Screener avançado
            </Link>
          </Button>
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
            <span className="tabular text-[11px] text-muted-foreground">
              {items.length} ativos
            </span>
          }
        />
        {q.isLoading ? <SkeletonRows rows={14} /> : null}
        {q.isError ? <div className="p-3"><ErrorState error={q.error} onRetry={() => q.refetch()} /></div> : null}
        {items.length > 0 ? (
          <table className="w-full text-[12.5px]">
            <thead className="sticky top-0 bg-surface z-10">
              <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left px-3 h-8 w-10">#</th>
                <SortH label="Ticker" col="ticker" sort={sort} order={order} onClick={setSort} align="left" />
                <th className="text-left px-3 h-8">Setor</th>
                <SortH label="Preço" col="price" sort={sort} order={order} onClick={setSort} />
                <SortH label="Var %" col="changePct" sort={sort} order={order} onClick={setSort} />
                <SortH label="DY" col="dy" sort={sort} order={order} onClick={setSort} />
                <SortH label="P/L" col="pe" sort={sort} order={order} onClick={setSort} />
                <SortH label="P/VP" col="pvp" sort={sort} order={order} onClick={setSort} />
                <SortH label="ROE" col="roe" sort={sort} order={order} onClick={setSort} />
                <SortH label="Score" col="score" sort={sort} order={order} onClick={setSort} />
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
                  <td className="px-3 h-8"><TickerBadge ticker={a.ticker} /></td>
                  <td className="px-3 h-8"><SectorBadge sector={a.sector} /></td>
                  <td className="px-3 h-8 text-right tabular">{fmtBRL(a.price)}</td>
                  <td className="px-3 h-8 text-right"><DeltaPill value={a.changePct} alreadyPct /></td>
                  <td className="px-3 h-8 text-right tabular">{fmtPct(a.dy, true)}</td>
                  <td className="px-3 h-8 text-right tabular">{fmtNum(a.pe)}</td>
                  <td className="px-3 h-8 text-right tabular">{fmtNum(a.pvp)}</td>
                  <td className="px-3 h-8 text-right tabular">{fmtPct(a.roe, true)}</td>
                  <td className="px-3 h-8 text-right"><ScoreBadge score={a.score} size="sm" /></td>
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
}: {
  label: string;
  col: string;
  sort: string;
  order: string;
  onClick: (c: string) => void;
  align?: "left" | "right";
}) {
  const active = sort === col;
  return (
    <th
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
