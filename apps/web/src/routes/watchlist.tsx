import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Eye, Plus, Trash2 } from "lucide-react";
import { Panel, PanelHeader, SectionHeader } from "@/components/app/primitives";
import { EmptyState } from "@/components/app/states";
import { ScoreBadge, TickerBadge } from "@/components/app/badges";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fmtBRL, fmtPct } from "@/lib/format";
import { useAssetDetail, useWatchlist, type Asset, type WatchlistItem } from "@/lib/queries";

export const Route = createFileRoute("/watchlist")({
  head: () => ({ meta: [{ title: "Watchlist" }] }),
  component: WatchlistPage,
});

function getScore(d: Asset | undefined): number | null {
  if (!d) return null;
  const s = d.score ?? d.overallScore ?? d.pontuacao ?? d.pontos;
  return typeof s === "number" && !Number.isNaN(s) ? s : null;
}

function WatchlistRow({
  item,
  onRemove,
}: {
  item: WatchlistItem;
  onRemove: (ticker: string) => void;
}) {
  const detail = useAssetDetail(item.type, item.ticker);
  const data = detail.data;
  const score = getScore(data);
  const price = data?.price;
  const changePct = data?.changePct;

  return (
    <tr className="border-b border-border/60 hover:bg-surface-2">
      <td className="px-3 h-10">
        <Link
          to="/research/$type/$ticker"
          params={{ type: item.type, ticker: item.ticker }}
          className="inline-flex items-center gap-2"
        >
          <TickerBadge ticker={item.ticker} />
        </Link>
      </td>
      <td className="px-3 h-10 text-xs text-muted-foreground">
        {item.type === "fii" ? "FII" : "Ação"}
      </td>
      <td className="px-3 h-10 text-xs text-muted-foreground truncate max-w-[180px]">
        {detail.isLoading ? (
          <span className="text-muted-foreground/70">…</span>
        ) : (
          (data?.name ?? data?.companyName ?? "—")
        )}
      </td>
      <td className="px-3 h-10 text-right tabular text-sm">
        {detail.isLoading ? "…" : fmtBRL(price)}
      </td>
      <td className="px-3 h-10 text-right tabular text-xs">
        {detail.isLoading ? (
          "…"
        ) : (
          <span
            className={
              (changePct ?? 0) > 0
                ? "text-positive"
                : (changePct ?? 0) < 0
                  ? "text-negative"
                  : "text-muted-foreground"
            }
          >
            {fmtPct(changePct, true)}
          </span>
        )}
      </td>
      <td className="px-3 h-10 text-right">
        {detail.isLoading ? (
          <span className="text-xs text-muted-foreground">…</span>
        ) : detail.isError ? (
          <span className="text-xs text-muted-foreground" title="API indisponível">
            —
          </span>
        ) : (
          <ScoreBadge score={score} size="sm" />
        )}
      </td>
      <td className="px-3 h-10 text-right">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-muted-foreground hover:text-negative"
          onClick={() => onRemove(item.ticker)}
          aria-label={`Remover ${item.ticker}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </td>
    </tr>
  );
}

function WatchlistPage() {
  const { items, add, remove, clear } = useWatchlist();
  const [ticker, setTicker] = useState("");
  const [type, setType] = useState<"stock" | "fii">("stock");
  const [error, setError] = useState<string | null>(null);

  const onAdd = (e: FormEvent) => {
    e.preventDefault();
    const t = ticker.trim().toUpperCase();
    if (!t) {
      setError("Informe um ticker.");
      return;
    }
    if (items.some((x) => x.ticker === t)) {
      setError(`${t} já está na watchlist.`);
      return;
    }
    add({ ticker: t, type });
    setTicker("");
    setError(null);
  };

  return (
    <div className="p-3 md:p-4 space-y-3">
      <SectionHeader
        title="Watchlist"
        subtitle="Acompanhe tickers salvos neste navegador. Score é filtro de qualidade, não preditor de retorno."
        actions={
          items.length > 0 ? (
            <Button variant="outline" size="sm" onClick={() => clear()}>
              Limpar lista
            </Button>
          ) : null
        }
      />

      <div className="grid grid-cols-12 gap-3">
        <Panel className="col-span-12 lg:col-span-4 h-fit">
          <PanelHeader title="Adicionar ticker" />
          <form className="p-4 space-y-3" onSubmit={onAdd}>
            <div className="space-y-1">
              <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Ticker
              </Label>
              <Input
                value={ticker}
                onChange={(e) => {
                  setTicker(e.target.value.toUpperCase());
                  setError(null);
                }}
                className="font-mono h-8"
                placeholder="PETR4"
                maxLength={12}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Tipo
              </Label>
              <Select value={type} onValueChange={(v) => setType(v as "stock" | "fii")}>
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="stock">Ação</SelectItem>
                  <SelectItem value="fii">FII</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {error ? <p className="text-xs text-negative">{error}</p> : null}
            <Button type="submit" className="w-full" size="sm">
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              Adicionar
            </Button>
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              Persistido em localStorage (
              <code className="px-1 rounded bg-surface-2">urano.watchlist</code>
              ). Não sincroniza entre dispositivos.
            </p>
          </form>
        </Panel>

        <Panel className="col-span-12 lg:col-span-8">
          <PanelHeader title={`Lista (${items.length})`} />
          {items.length === 0 ? (
            <EmptyState
              icon={<Eye className="h-8 w-8" />}
              title="Watchlist vazia"
              description="Adicione tickers para acompanhar preço e score de qualidade."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                    <th className="text-left px-3 h-8">Ticker</th>
                    <th className="text-left px-3 h-8">Tipo</th>
                    <th className="text-left px-3 h-8">Nome</th>
                    <th className="text-right px-3 h-8">Preço</th>
                    <th className="text-right px-3 h-8">Var %</th>
                    <th className="text-right px-3 h-8">Score</th>
                    <th className="text-right px-3 h-8 w-10" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <WatchlistRow key={item.ticker} item={item} onRemove={remove} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
