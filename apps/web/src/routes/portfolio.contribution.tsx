import { createFileRoute } from "@tanstack/react-router";
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
import { TickerBadge } from "@/components/app/badges";
import { fmtBRL, fmtPct } from "@/lib/format";
import { asArray } from "@/lib/queries";
import { Sparkles } from "lucide-react";

export const Route = createFileRoute("/portfolio/contribution")({
  head: () => ({ meta: [{ title: "Simulador de aporte" }] }),
  component: ContributionPage,
});

function ContributionPage() {
  const [amount, setAmount] = useState("3000");
  const [profile, setProfile] = useState("balanced");
  const [onlyTypes, setOnlyTypes] = useState("all");
  const [excludeSectors, setExcludeSectors] = useState("");
  const [positions, setPositions] = useState("");

  const run = useMutation({
    mutationFn: async () => {
      const body: any = {
        amount: Number(amount),
        profile,
        onlyTypes: onlyTypes === "all" ? undefined : [onlyTypes],
        excludeSectors: excludeSectors
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        positions: positions
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      };
      return apiFetch({ path: "/analysis/contribution", method: "POST", body });
    },
  });

  const result: any = run.data ?? {};
  const buys = asArray(result.buys ?? result.purchases ?? result.recommendations);
  const discards = asArray(result.discards ?? result.rejected);

  return (
    <div className="p-3 md:p-4 space-y-3">
      <SectionHeader
        title="Simulador de aporte"
        subtitle="Aloque um valor entre os melhores ativos segundo seus critérios."
      />
      <div className="grid grid-cols-12 gap-3">
        <Panel className="col-span-12 lg:col-span-4 h-fit">
          <PanelHeader title="Parâmetros" />
          <form
            className="p-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              run.mutate();
            }}
          >
            <Field label="Valor (R$)">
              <Input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="font-mono h-8"
                inputMode="numeric"
              />
            </Field>
            <Field label="Perfil">
              <Select value={profile} onValueChange={setProfile}>
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="conservative">Conservador</SelectItem>
                  <SelectItem value="balanced">Moderado</SelectItem>
                  <SelectItem value="aggressive">Agressivo</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Tipos permitidos">
              <Select value={onlyTypes} onValueChange={setOnlyTypes}>
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Ações + FIIs</SelectItem>
                  <SelectItem value="stock">Somente Ações</SelectItem>
                  <SelectItem value="fii">Somente FIIs</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Setores excluídos">
              <Input
                value={excludeSectors}
                onChange={(e) => setExcludeSectors(e.target.value)}
                placeholder="Bancos, Petróleo"
                className="h-8"
              />
            </Field>
            <Field label="Posições atuais (tickers)">
              <Input
                value={positions}
                onChange={(e) => setPositions(e.target.value)}
                placeholder="PETR4, VALE3, HGLG11"
                className="h-8 font-mono"
              />
            </Field>
            <Button type="submit" className="w-full" disabled={run.isPending}>
              <Sparkles className="h-3.5 w-3.5 mr-1.5" />
              {run.isPending ? "Simulando…" : "Simular alocação"}
            </Button>
          </form>
        </Panel>

        <div className="col-span-12 lg:col-span-8 space-y-3">
          {run.isError ? <ErrorState error={run.error} onRetry={() => run.mutate()} /> : null}
          {!run.data && !run.isPending && !run.isError ? (
            <Panel>
              <EmptyState
                title="Ainda sem simulação"
                description="Preencha os parâmetros e clique em Simular alocação."
              />
            </Panel>
          ) : null}
          {run.data ? (
            <>
              {result.summary || result.justification ? (
                <Panel>
                  <PanelHeader title="Justificativa" />
                  <div className="p-3 text-sm text-foreground/90 whitespace-pre-wrap">
                    {result.summary ?? result.justification}
                  </div>
                </Panel>
              ) : null}
              <Panel>
                <PanelHeader
                  title="Compras sugeridas"
                  actions={
                    <span className="tabular text-[11px] text-muted-foreground">{buys.length}</span>
                  }
                />
                {buys.length === 0 ? (
                  <EmptyState title="Sem sugestões de compra" />
                ) : (
                  <table className="w-full text-[12.5px]">
                    <thead>
                      <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                        <th className="text-left px-3 h-8">Ticker</th>
                        <th className="text-right px-3 h-8">Qtd</th>
                        <th className="text-right px-3 h-8">Preço</th>
                        <th className="text-right px-3 h-8">Valor</th>
                        <th className="text-right px-3 h-8">Peso</th>
                        <th className="text-left px-3 h-8">Razão</th>
                      </tr>
                    </thead>
                    <tbody>
                      {buys.map((b: any, i: number) => (
                        <tr key={i} className="border-b border-border/60">
                          <td className="px-3 h-9">
                            <TickerBadge ticker={b.ticker} />
                          </td>
                          <td className="px-3 h-9 text-right tabular">{b.quantity ?? b.qty}</td>
                          <td className="px-3 h-9 text-right tabular">{fmtBRL(b.price)}</td>
                          <td className="px-3 h-9 text-right tabular">
                            {fmtBRL(b.total ?? b.value)}
                          </td>
                          <td className="px-3 h-9 text-right tabular">{fmtPct(b.weight, true)}</td>
                          <td className="px-3 h-9 text-xs text-muted-foreground truncate max-w-[280px]">
                            {b.reason ?? b.justification ?? "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Panel>
              {discards.length > 0 ? (
                <Panel>
                  <PanelHeader title="Descartados" />
                  <div className="divide-y divide-border">
                    {discards.map((d: any, i: number) => (
                      <div key={i} className="flex items-center gap-3 px-3 py-2 text-xs">
                        <TickerBadge ticker={d.ticker} />
                        <span className="text-muted-foreground flex-1">
                          {d.reason ?? d.justification}
                        </span>
                      </div>
                    ))}
                  </div>
                </Panel>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
