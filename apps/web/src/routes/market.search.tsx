import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { asArray, useRanking, type Asset } from "@/lib/queries";
import { Panel, PanelHeader, SectionHeader } from "@/components/app/primitives";
import { Input } from "@/components/ui/input";
import { DeltaPill, ScoreBadge, SectorBadge, TickerBadge } from "@/components/app/badges";
import { fmtBRL, fmtPct } from "@/lib/format";
import { EmptyState } from "@/components/app/states";
import { useMemo, useState } from "react";
import { Search } from "lucide-react";

export const Route = createFileRoute("/market/search")({
  head: () => ({ meta: [{ title: "Pesquisa — Market" }] }),
  component: SearchPage,
});

function SearchPage() {
  const [q, setQ] = useState("");
  const stocks = useRanking({ type: "stock", limit: 500 });
  const fiis = useRanking({ type: "fii", limit: 500 });
  const navigate = useNavigate();

  const all = useMemo(
    () => [
      ...asArray<Asset>(stocks.data).map((a) => ({ ...a, type: a.type ?? "stock" })),
      ...asArray<Asset>(fiis.data).map((a) => ({ ...a, type: a.type ?? "fii" })),
    ],
    [stocks.data, fiis.data],
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return all.slice(0, 40);
    return all
      .filter(
        (a) =>
          a.ticker?.toLowerCase().includes(needle) ||
          a.name?.toLowerCase().includes(needle) ||
          a.sector?.toLowerCase().includes(needle),
      )
      .slice(0, 80);
  }, [all, q]);

  return (
    <div className="p-3 md:p-4 space-y-3">
      <SectionHeader title="Pesquisa" subtitle="Busque por ticker, nome ou setor." />
      <Panel>
        <div className="p-3 border-b border-border">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="ex.: PETR4, banco, energia…"
              autoFocus
              className="h-9 pl-8 font-mono"
            />
          </div>
        </div>
        {filtered.length === 0 ? (
          <EmptyState title="Sem resultados" description="Ajuste a busca." />
        ) : (
          <div className="divide-y divide-border">
            {filtered.map((a) => (
              <button
                key={`${a.type}-${a.ticker}`}
                onClick={() =>
                  navigate({
                    to: "/research/$type/$ticker",
                    params: { type: a.type, ticker: a.ticker },
                  })
                }
                className="w-full flex items-center gap-3 px-3 py-2 hover:bg-surface-2 text-left"
              >
                <TickerBadge ticker={a.ticker} />
                <span className="flex-1 truncate text-xs text-muted-foreground">
                  {a.name ?? ""}
                </span>
                <SectorBadge sector={a.sector} />
                <span className="tabular text-xs w-20 text-right">{fmtBRL(a.price)}</span>
                <div className="w-16 text-right">
                  <DeltaPill value={a.changePct} alreadyPct />
                </div>
                <ScoreBadge score={a.score} size="sm" />
              </button>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
