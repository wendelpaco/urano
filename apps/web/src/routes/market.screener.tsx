import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { Panel, PanelHeader, SectionHeader } from "@/components/app/primitives";
import { asAssets, useScreener } from "@/lib/queries";
import {
  DeltaPill,
  DY_TTM_LABEL,
  DY_TTM_TITLE,
  ScoreBadge,
  SectorBadge,
  StanceBadge,
  TickerBadge,
} from "@/components/app/badges";
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
import { RotateCcw, Sparkles } from "lucide-react";
import {
  SCREENER_CLEAR,
  SCREENER_PRESETS,
  applyScreenerPreset,
  type ScreenerPreset,
} from "@/lib/screener-presets";

const numOpt = () => fallback(z.string(), "").default("");

const searchSchema = z.object({
  type: fallback(z.enum(["stock", "fii"]), "stock").default("stock"),
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
  vacancyMax: numOpt(),
  classification: numOpt(),
  sortBy: fallback(z.string(), "score").default("score"),
  order: fallback(z.enum(["asc", "desc"]), "desc").default("desc"),
  /** id do preset ativo (só para highlight na UI) */
  preset: numOpt(),
});

export const Route = createFileRoute("/market/screener")({
  validateSearch: zodValidator(searchSchema),
  head: () => ({ meta: [{ title: "Screener — Market" }] }),
  component: ScreenerPage,
});

const stockFilterDefs: {
  key: keyof z.infer<typeof searchSchema>;
  label: string;
}[] = [
  { key: "peMin", label: "P/L" },
  { key: "pvpMin", label: "P/VP" },
  { key: "dyMin", label: DY_TTM_LABEL },
  { key: "roeMin", label: "ROE %" },
  { key: "scoreMin", label: "Score" },
];

const fiiFilterDefs: {
  key: keyof z.infer<typeof searchSchema>;
  label: string;
}[] = [
  { key: "pvpMin", label: "P/VP" },
  { key: "dyMin", label: DY_TTM_LABEL },
  { key: "scoreMin", label: "Score" },
];

function ScreenerPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/market/screener" });
  const isFii = search.type === "fii";
  // Send only non-empty params to API (backend owns validation). Omit UI-only `preset`.
  const params = Object.fromEntries(
    Object.entries(search).filter(
      ([k, v]) => k !== "preset" && v !== "" && v !== undefined,
    ),
  );
  const q = useScreener(params);
  const items = asAssets(q.data);
  const filterDefs = isFii ? fiiFilterDefs : stockFilterDefs;
  const activePreset = SCREENER_PRESETS.find((p) => p.id === search.preset);

  const set = (k: keyof z.infer<typeof searchSchema>, v: string) =>
    navigate({ search: (p) => ({ ...p, [k]: v, preset: "" }) });

  const applyPreset = (preset: ScreenerPreset) => {
    const next = applyScreenerPreset(preset);
    navigate({
      search: () =>
        searchSchema.parse({
          ...SCREENER_CLEAR,
          ...next,
          preset: preset.id,
        }),
    });
  };

  return (
    <div className="p-3 md:p-4 space-y-3">
      <SectionHeader
        title="Screener"
        subtitle={
          isFii
            ? "FIIs por DY, P/VP, score, vacância e segmento — triagem experimental."
            : "Ações por filtros fundamentalistas + score de qualidade. Use um preset para começar."
        }
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link
                to="/portfolio/contribution"
                search={{
                  fromScratch: "1",
                  profile: activePreset?.suggestProfile ?? "conservador",
                  amount: "3000",
                }}
              >
                <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                Simular aporte
              </Link>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                navigate({
                  search: () => searchSchema.parse({ ...SCREENER_CLEAR, preset: "" }),
                })
              }
            >
              <RotateCcw className="h-3.5 w-3.5 mr-1.5" /> Limpar
            </Button>
          </div>
        }
      />

      <Panel>
        <PanelHeader title="Presets para começar" />
        <div className="p-3 flex flex-wrap gap-2">
          {SCREENER_PRESETS.map((p) => {
            const active = search.preset === p.id;
            return (
              <button
                key={p.id}
                type="button"
                title={p.description}
                onClick={() => applyPreset(p)}
                className={
                  "rounded border px-2.5 py-1.5 text-left text-xs transition-colors max-w-[14rem] " +
                  (active
                    ? "border-primary/50 bg-primary/10 text-primary"
                    : "border-border bg-surface-2/40 text-foreground/90 hover:bg-surface-2")
                }
              >
                <span className="font-medium block">{p.label}</span>
                <span className="text-[10px] text-muted-foreground line-clamp-2">
                  {p.description}
                </span>
              </button>
            );
          })}
        </div>
      </Panel>

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
                  <SelectItem value="stock">Ações</SelectItem>
                  <SelectItem value="fii">FIIs</SelectItem>
                </SelectContent>
              </Select>
            </FilterField>

            <FilterField label={isFii ? "Segmento" : "Setor"}>
              <Input
                value={search.sector}
                onChange={(e) => set("sector", e.target.value)}
                placeholder={isFii ? "ex.: Logística" : "ex.: Bancos"}
                className="h-8"
              />
            </FilterField>

            {filterDefs.map((f) => {
              const minKey = f.key;
              const maxKey = minKey.replace(/Min$/, "Max") as keyof z.infer<typeof searchSchema>;
              const isDy = minKey === "dyMin";
              return (
                <FilterField key={f.key} label={f.label}>
                  <div className="grid grid-cols-2 gap-1.5" title={isDy ? DY_TTM_TITLE : undefined}>
                    <Input
                      value={String(search[minKey] ?? "")}
                      onChange={(e) => set(minKey, e.target.value)}
                      placeholder="min"
                      className="h-8 font-mono"
                    />
                    <Input
                      value={String(search[maxKey] ?? "")}
                      onChange={(e) => set(maxKey, e.target.value)}
                      placeholder="max"
                      className="h-8 font-mono"
                    />
                  </div>
                </FilterField>
              );
            })}

            {isFii ? (
              <>
                <FilterField label="Vacância máx. %">
                  <Input
                    value={search.vacancyMax}
                    onChange={(e) => set("vacancyMax", e.target.value)}
                    placeholder="ex.: 10"
                    className="h-8 font-mono"
                  />
                </FilterField>
                <FilterField label="Classificação">
                  <Select
                    value={search.classification || "any"}
                    onValueChange={(v) => set("classification", v === "any" ? "" : v)}
                  >
                    <SelectTrigger className="h-8">
                      <SelectValue placeholder="Qualquer" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="any">Qualquer</SelectItem>
                      <SelectItem value="tijolo">Tijolo</SelectItem>
                      <SelectItem value="papel">Papel</SelectItem>
                      <SelectItem value="hibrido">Híbrido</SelectItem>
                      <SelectItem value="fundo_de_fundos">FoF</SelectItem>
                    </SelectContent>
                  </Select>
                </FilterField>
              </>
            ) : null}

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
                    <th className="text-left px-3 h-8">{isFii ? "Segmento" : "Setor"}</th>
                    <th className="text-right px-3 h-8">Preço</th>
                    {!isFii ? <th className="text-right px-3 h-8">Var %</th> : null}
                    <th className="text-right px-3 h-8" title={DY_TTM_TITLE}>
                      {DY_TTM_LABEL}
                    </th>
                    {!isFii ? <th className="text-right px-3 h-8">P/L</th> : null}
                    <th className="text-right px-3 h-8">P/VP</th>
                    {!isFii ? <th className="text-right px-3 h-8">ROE</th> : null}
                    {isFii ? <th className="text-right px-3 h-8">Vacância</th> : null}
                    <th className="text-right px-3 h-8">Score</th>
                    <th className="text-left px-3 h-8">Postura</th>
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
                          params: {
                            type: a.type ?? (isFii ? "fii" : "stock"),
                            ticker: a.ticker,
                          },
                        })
                      }
                    >
                      <td className="px-3 h-8">
                        <TickerBadge ticker={a.ticker} />
                      </td>
                      <td className="px-3 h-8">
                        <SectorBadge
                          sector={
                            (a.sector as string | undefined) ??
                            (a.segment as string | undefined)
                          }
                        />
                      </td>
                      <td className="px-3 h-8 text-right tabular">{fmtBRL(a.price)}</td>
                      {!isFii ? (
                        <td className="px-3 h-8 text-right">
                          <DeltaPill
                            value={
                              a.changePct ?? (a as { changePercent?: number }).changePercent
                            }
                            alreadyPct
                          />
                        </td>
                      ) : null}
                      <td className="px-3 h-8 text-right tabular" title={DY_TTM_TITLE}>
                        {fmtPct(a.dy ?? (a as { dividendYield?: number }).dividendYield, true)}
                      </td>
                      {!isFii ? (
                        <td className="px-3 h-8 text-right tabular">
                          {fmtNum(a.pe ?? (a as { peRatio?: number }).peRatio)}
                        </td>
                      ) : null}
                      <td className="px-3 h-8 text-right tabular">{fmtNum(a.pvp)}</td>
                      {!isFii ? (
                        <td className="px-3 h-8 text-right tabular">{fmtPct(a.roe, true)}</td>
                      ) : null}
                      {isFii ? (
                        <td className="px-3 h-8 text-right tabular">
                          {fmtPct(a.vacancy as number | undefined, true)}
                        </td>
                      ) : null}
                      <td className="px-3 h-8 text-right">
                        <ScoreBadge score={a.score} size="sm" />
                      </td>
                      <td className="px-3 h-8">
                        <StanceBadge
                          label={a.stanceLabel as string | undefined}
                          tone={a.stanceTone as string | undefined}
                        />
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
