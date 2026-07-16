import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { asArray, useRanking, useLazySearch, type Asset, type LazyAsset } from "@/lib/queries";
import { Panel, PanelHeader, SectionHeader } from "@/components/app/primitives";
import { Input } from "@/components/ui/input";
import { DeltaPill, ScoreBadge, SectorBadge, TickerBadge } from "@/components/app/badges";
import { fmtBRL, fmtPct } from "@/lib/format";
import { EmptyState } from "@/components/app/states";
import { useMemo, useState } from "react";
import { Search, Loader2 } from "lucide-react";

export const Route = createFileRoute("/market/search")({
  head: () => ({ meta: [{ title: "Pesquisa — Market" }] }),
  component: SearchPage,
});

function SearchPage() {
  const [q, setQ] = useState("");
  const stocks = useRanking({ type: "stock", limit: 500 });
  const fiis = useRanking({ type: "fii", limit: 500 });
  const navigate = useNavigate();

  // Lazy search: fallback quando o ranking está vazio
  const lazyQ = useLazySearch(q.trim().length >= 2 ? q.trim() : "");
  const lazyResults = useMemo(
    () => asArray<LazyAsset>(lazyQ.data?.results ?? lazyQ.data),
    [lazyQ.data],
  );
  // UX-6: estado de scraping respeita loading/error. Não fica travado:
  // - mostra spinner durante fetch de live-scrape
  // - esconde no erro (lazyQ.isError) mesmo que data antiga tenha source='live_scrape'
  // - esconde quando data é cache/warmed (source != 'live_scrape')
  const lazyData = lazyQ.data as { source?: string } | undefined;
  const isScraping = lazyQ.isLoading && !lazyQ.isError && (
    lazyData?.source === "live_scrape" || !lazyData
  );

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

    // Primeiro tenta ranking cache
    const fromRanking = all
      .filter(
        (a) =>
          a.ticker?.toLowerCase().includes(needle) ||
          a.name?.toLowerCase().includes(needle) ||
          a.sector?.toLowerCase().includes(needle),
      )
      .slice(0, 80);

    // Se ranking tem resultados, usa eles
    if (fromRanking.length > 0) return fromRanking;

    // Fallback: lazy search (scraping ao vivo)
    if (lazyResults.length > 0) {
      return lazyResults.map((r) => ({
        ticker: r.ticker,
        name: r.name,
        type: r.type,
        price: r.price,
        changePct: r.changePct,
        score: r.score,
        sector: r.sector,
      })) as Asset[];
    }

    return [];
  }, [all, q, lazyResults]);

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
        {isScraping && q.trim().length >= 2 ? (
          <div className="flex items-center gap-3 px-4 py-8 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">Buscando dados em tempo real...</span>
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            title="Sem resultados"
            description={
              q.trim().length >= 2
                ? `Nada encontrado para "${q}". Tente um ticker como PETR4 ou HGLG11.`
                : "Digite um ticker, nome ou setor para buscar."
            }
          />
        ) : (
          <div className="divide-y divide-border">
            {filtered.map((a) => (
              <button
                key={`${a.type}-${a.ticker}`}
                onClick={() =>
                  navigate({
                    to: "/research/$type/$ticker",
                    params: { type: a.type || "stock", ticker: a.ticker },
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
