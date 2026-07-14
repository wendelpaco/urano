import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { Panel, PanelHeader, SectionHeader } from "@/components/app/primitives";
import { asArray, useScreener, type Asset } from "@/lib/queries";
import { DeltaPill, ScoreBadge, SectorBadge, TickerBadge } from "@/components/app/badges";
import { fmtBRL, fmtNum, fmtPct } from "@/lib/format";
import { ErrorState, SkeletonRows, EmptyState } from "@/components/app/states";
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
import { RotateCcw } from "lucide-react";

const numOpt = () => fallback(z.string(), "").default("");

const searchSchema = z.object({
  type: fallback(z.enum(["all", "stock", "fii"]), "all").default("all"),
  sector: numOpt(),
  peMin: numOpt(),
  peMax: numOpt(),
  pvpMin: numOpt(),
  pvpMax: numOpt(),
  roeMin: numOpt(),
  roeMax: numOpt(),
  dyMin: numOpt(),
  dyMax: numOpt(),
  marketCapMin: numOpt(),
  marketCapMax: numOpt(),
  liquidityMin: numOpt(),
  scoreMin: numOpt(),
  scoreMax: numOpt(),
  sortBy: fallback(z.string(), "score").default("score"),
  order: fallback(z.enum(["asc", "desc"]), "desc").default("desc"),
});

export const Route = createFileRoute("/market/screener")({
  validateSearch: zodValidator(searchSchema),
  head: () => ({ meta: [{ title: "Screener — Market" }] }),
  component: ScreenerPage,
});

const filterDefs: {
  key: keyof z.infer<typeof searchSchema>;
  label: string;
  kind: "range" | "min" | "text";
}[] = [
  { key: "peMin", label: "P/L", kind: "range" },
  { key: "pvpMin", label: "P/VP", kind: "range" },
  { key: "dyMin", label: "DY %", kind: "range" },
  { key: "roeMin", label: "ROE %", kind: "range" },
  { key: "marketCapMin", label: "Market Cap", kind: "range" },
  { key: "scoreMin", label: "Score", kind: "range" },
];

function ScreenerPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/market/screener" });
  // Send only non-empty params to API (backend owns validation).
  const params = Object.fromEntries(
    Object.entries(search).filter(([, v]) => v !== "" && v !== undefined),
  );
  const q = useScreener(params);
  const items = asArray<Asset>(q.data);

  const set = (k: keyof z.infer<typeof searchSchema>, v: string) =>
    navigate({ search: (p) => ({ ...p, [k]: v }) });

  return (
    <div className="p-3 md:p-4 space-y-3">
      <SectionHeader
        title="Screener"
        subtitle="Encontre ativos usando 15 filtros fundamentalistas."
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate({ search: () => searchSchema.parse({}) })}
          >
            <RotateCcw className="h-3.5 w-3.5 mr-1.5" /> Limpar
          </Button>
        }
      />

      <div className="grid grid-cols-12 gap-3">
        <Panel className="col-span-12 lg:col-span-3 h-fit">
          <PanelHeader title="Filtros" />
          <div className="p-3 space-y-4">
            <FilterField label="Tipo">
              <Select value={search.type} onValueChange={(v) => set("type", v)}>
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="stock">Ações</SelectItem>
                  <SelectItem value="fii">FIIs</SelectItem>
                </SelectContent>
              </Select>
            </FilterField>

            <FilterField label="Setor">
              <Input
                value={search.sector}
                onChange={(e) => set("sector", e.target.value)}
                placeholder="ex.: Bancos"
                className="h-8"
              />
            </FilterField>

            {filterDefs.map((f) => {
              const minKey = f.key;
              const maxKey = minKey.replace(/Min$/, "Max") as keyof z.infer<typeof searchSchema>;
              return (
                <FilterField key={f.key} label={f.label}>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Input
                      value={search[minKey] ?? ""}
                      onChange={(e) => set(minKey, e.target.value)}
                      placeholder="min"
                      className="h-8 font-mono"
                    />
                    <Input
                      value={search[maxKey] ?? ""}
                      onChange={(e) => set(maxKey, e.target.value)}
                      placeholder="max"
                      className="h-8 font-mono"
                    />
                  </div>
                </FilterField>
              );
            })}

            <FilterField label="Liquidez mínima">
              <Input
                value={search.liquidityMin}
                onChange={(e) => set("liquidityMin", e.target.value)}
                placeholder="ex.: 1000000"
                className="h-8 font-mono"
              />
            </FilterField>
          </div>
        </Panel>

        <div className="col-span-12 lg:col-span-9">
          <Panel>
            <PanelHeader
              title="Resultados"
              actions={
                <span className="tabular text-[11px] text-muted-foreground">
                  {q.isFetching ? "carregando…" : `${items.length} ativos`}
                </span>
              }
            />
            {q.isLoading ? <SkeletonRows rows={16} /> : null}
            {q.isError ? (
              <div className="p-3">
                <ErrorState error={q.error} onRetry={() => q.refetch()} />
              </div>
            ) : null}
            {q.isSuccess && items.length === 0 ? (
              <EmptyState
                title="Nenhum ativo atende aos filtros"
                description="Ajuste os parâmetros para relaxar a busca."
              />
            ) : null}
            {items.length > 0 ? (
              <table className="w-full text-[12.5px]">
                <thead className="sticky top-0 bg-surface z-10">
                  <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                    <th className="text-left px-3 h-8">Ticker</th>
                    <th className="text-left px-3 h-8">Setor</th>
                    <th className="text-right px-3 h-8">Preço</th>
                    <th className="text-right px-3 h-8">Var %</th>
                    <th className="text-right px-3 h-8">DY</th>
                    <th className="text-right px-3 h-8">P/L</th>
                    <th className="text-right px-3 h-8">P/VP</th>
                    <th className="text-right px-3 h-8">ROE</th>
                    <th className="text-right px-3 h-8">Score</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((a) => (
                    <tr
                      key={a.ticker}
                      className="border-b border-border/60 hover:bg-surface-2 cursor-pointer"
                      onClick={() =>
                        navigate({
                          to: "/research/$type/$ticker",
                          params: { type: a.type ?? "stock", ticker: a.ticker },
                        })
                      }
                    >
                      <td className="px-3 h-8">
                        <TickerBadge ticker={a.ticker} />
                      </td>
                      <td className="px-3 h-8">
                        <SectorBadge sector={a.sector} />
                      </td>
                      <td className="px-3 h-8 text-right tabular">{fmtBRL(a.price)}</td>
                      <td className="px-3 h-8 text-right">
                        <DeltaPill value={a.changePct} alreadyPct />
                      </td>
                      <td className="px-3 h-8 text-right tabular">{fmtPct(a.dy, true)}</td>
                      <td className="px-3 h-8 text-right tabular">{fmtNum(a.pe)}</td>
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
      </div>
    </div>
  );
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
