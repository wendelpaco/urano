import { createFileRoute, Link } from "@tanstack/react-router";
import { Panel, PanelHeader, SectionHeader } from "@/components/app/primitives";
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
import { useMutation } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { useState } from "react";
import { ErrorState, EmptyState } from "@/components/app/states";
import {
  DY_TTM_LABEL,
  DY_TTM_TITLE,
  SCORE_BADGE_TRUST_TITLE,
  ScoreBadge,
  TickerBadge,
} from "@/components/app/badges";
import { fmtBRL, fmtNum, fmtPct } from "@/lib/format";
import { asArray } from "@/lib/queries";
import { GitCompareArrows } from "lucide-react";

export const Route = createFileRoute("/market/compare")({
  head: () => ({ meta: [{ title: "Comparador" }] }),
  component: ComparePage,
});

type CompareItem = {
  ticker: string;
  name?: string;
  price?: number | null;
  score?: number | null;
  peRatio?: number | null;
  pvp?: number | null;
  roe?: number | null;
  dy?: number | null;
  netMargin?: number | null;
  debtToEquity?: number | null;
  diagnosis?: string;
  recommendation?: string;
  highlights?: string[];
  warnings?: string[];
  error?: string;
};

function ComparePage() {
  const [tickers, setTickers] = useState("PETR4, VALE3, WEGE3");
  const [type, setType] = useState<"stock" | "fii">("stock");

  const run = useMutation({
    mutationFn: async () => {
      const list = tickers
        .split(/[,\s]+/)
        .map((t) => t.trim().toUpperCase())
        .filter(Boolean);
      if (list.length < 2) throw new Error("Informe ao menos 2 tickers.");
      if (list.length > 10) throw new Error("Máximo de 10 tickers.");
      const res = await apiFetch<{ items?: CompareItem[]; data?: CompareItem[] } | CompareItem[]>({
        path: "/analysis/compare",
        method: "POST",
        body: { tickers: list, type },
      });
      return asArray<CompareItem>(res);
    },
  });

  const rows = run.data ?? [];

  return (
    <div className="p-3 md:p-4 space-y-3">
      <SectionHeader
        title="Comparador"
        subtitle="Lado a lado: score de qualidade, valuation e diagnóstico. Score não prediz retorno."
      />

      <div className="grid grid-cols-12 gap-3">
        <Panel className="col-span-12 lg:col-span-4 h-fit">
          <PanelHeader title="Ativos" />
          <form
            className="p-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              run.mutate();
            }}
          >
            <div className="space-y-1">
              <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Tickers (2–10)
              </Label>
              <Input
                value={tickers}
                onChange={(e) => setTickers(e.target.value)}
                className="font-mono h-8"
                placeholder="PETR4, VALE3, WEGE3"
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
                  <SelectItem value="stock">Ações</SelectItem>
                  <SelectItem value="fii">FIIs</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" className="w-full" disabled={run.isPending}>
              <GitCompareArrows className="h-3.5 w-3.5 mr-1.5" />
              {run.isPending ? "Comparando…" : "Comparar"}
            </Button>
          </form>
        </Panel>

        <div className="col-span-12 lg:col-span-8 space-y-3">
          {run.isError ? <ErrorState error={run.error} onRetry={() => run.mutate()} /> : null}
          {!run.data && !run.isPending && !run.isError ? (
            <Panel>
              <EmptyState
                title="Sem comparação"
                description="Informe os tickers e clique em Comparar."
              />
            </Panel>
          ) : null}

          {rows.length > 0 ? (
            <>
              <Panel>
                <PanelHeader title="Tabela comparativa" />
                <div className="overflow-x-auto">
                  <table className="w-full text-[12.5px]">
                    <thead>
                      <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                        <th className="text-left px-3 h-8">Ticker</th>
                        <th className="text-right px-3 h-8" title={SCORE_BADGE_TRUST_TITLE}>
                          Score
                        </th>
                        <th className="text-right px-3 h-8">Preço</th>
                        <th className="text-right px-3 h-8">P/L</th>
                        <th className="text-right px-3 h-8">P/VP</th>
                        <th className="text-right px-3 h-8">ROE</th>
                        {/* TODO(F3): chip DY vs CDI se compare passar a carregar useMacro */}
                        <th className="text-right px-3 h-8" title={DY_TTM_TITLE}>
                          {DY_TTM_LABEL}
                        </th>
                        <th className="text-right px-3 h-8">Margem</th>
                        <th className="text-right px-3 h-8">Dív/PL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.ticker} className="border-b border-border/60 hover:bg-surface-2">
                          <td className="px-3 h-9">
                            {r.error ? (
                              <span className="font-mono text-muted-foreground">{r.ticker}</span>
                            ) : (
                              <Link
                                to="/research/$type/$ticker"
                                params={{ type, ticker: r.ticker }}
                              >
                                <TickerBadge ticker={r.ticker} />
                              </Link>
                            )}
                          </td>
                          <td className="px-3 h-9 text-right">
                            {r.score != null ? <ScoreBadge score={r.score} /> : "—"}
                          </td>
                          <td className="px-3 h-9 text-right tabular">{fmtBRL(r.price)}</td>
                          <td className="px-3 h-9 text-right tabular">
                            {fmtNum(r.peRatio ?? (r as { pe?: number | null }).pe ?? null)}
                          </td>
                          <td className="px-3 h-9 text-right tabular">
                            {fmtNum(r.pvp ?? (r as { pbRatio?: number | null }).pbRatio ?? null)}
                          </td>
                          <td className="px-3 h-9 text-right tabular">{fmtPct(r.roe, true)}</td>
                          <td className="px-3 h-9 text-right tabular" title={DY_TTM_TITLE}>
                            {fmtPct(
                              r.dy ??
                                (r as { dividendYield?: number | null }).dividendYield ??
                                null,
                              true,
                            )}
                          </td>
                          <td className="px-3 h-9 text-right tabular">
                            {fmtPct(r.netMargin, true)}
                          </td>
                          <td className="px-3 h-9 text-right tabular">{fmtNum(r.debtToEquity)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {rows.map((r) => (
                  <Panel key={`d-${r.ticker}`}>
                    <PanelHeader title={r.ticker} />
                    <div className="p-3 space-y-2 text-xs">
                      {r.error ? (
                        <p className="text-destructive">{r.error}</p>
                      ) : (
                        <>
                          <p className="text-muted-foreground">{r.name}</p>
                          {r.diagnosis ? (
                            <p className="leading-relaxed text-foreground/90">{r.diagnosis}</p>
                          ) : null}
                          {r.recommendation ? (
                            <p className="text-muted-foreground">
                              <span className="font-medium text-foreground">Nota: </span>
                              {r.recommendation}
                            </p>
                          ) : null}
                          {(r.highlights?.length ?? 0) > 0 ? (
                            <ul className="list-disc pl-4 text-muted-foreground space-y-0.5">
                              {r.highlights!.map((h, i) => (
                                <li key={i}>{h}</li>
                              ))}
                            </ul>
                          ) : null}
                          {(r.warnings?.length ?? 0) > 0 ? (
                            <ul className="list-disc pl-4 text-amber-500/90 space-y-0.5">
                              {r.warnings!.map((w, i) => (
                                <li key={i}>{w}</li>
                              ))}
                            </ul>
                          ) : null}
                        </>
                      )}
                    </div>
                  </Panel>
                ))}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
