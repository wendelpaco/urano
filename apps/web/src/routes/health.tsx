import { createFileRoute } from "@tanstack/react-router";
import { Panel, PanelHeader, SectionHeader } from "@/components/app/primitives";
import { useHealthData } from "@/components/app/HealthBanner";
import { HealthBadge } from "@/components/app/badges";
import { LoadingState, ErrorState, EmptyState } from "@/components/app/states";
import { fmtPct } from "@/lib/format";

export const Route = createFileRoute("/health")({
  head: () => ({ meta: [{ title: "Data Health" }] }),
  component: HealthPage,
});

function HealthPage() {
  const h = useHealthData();
  const sources = h.data?.sources ?? [];
  const warnings = h.data?.warnings ?? [];

  return (
    <div className="p-3 md:p-4 space-y-3">
      <SectionHeader
        title="Data Health"
        subtitle="Cobertura, frescor e alertas das fontes de dados que alimentam o terminal."
        actions={<HealthBadge status={h.data?.status ?? (h.isError ? "error" : "ok")} />}
      />

      {h.isLoading ? <LoadingState /> : null}
      {h.isError ? <ErrorState error={h.error} onRetry={() => h.refetch()} /> : null}

      {h.isSuccess ? (
        <div className="grid grid-cols-12 gap-3">
          <Panel className="col-span-12 xl:col-span-7">
            <PanelHeader title="Fontes de dados" />
            {sources.length === 0 ? (
              <EmptyState title="Sem fontes reportadas" />
            ) : (
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                    <th className="text-left px-3 h-8">Fonte</th>
                    <th className="text-left px-3 h-8">Status</th>
                    <th className="text-right px-3 h-8">Cobertura</th>
                    <th className="text-right px-3 h-8">Frescor</th>
                    <th className="text-right px-3 h-8">Atualizado</th>
                  </tr>
                </thead>
                <tbody>
                  {sources.map((s) => (
                    <tr key={s.name} className="border-b border-border/60">
                      <td className="px-3 h-9">{s.name}</td>
                      <td className="px-3 h-9">
                        <HealthBadge status={s.status ?? "ok"} />
                      </td>
                      <td className="px-3 h-9 text-right tabular">
                        {typeof s.coverage === "number" ? fmtPct(s.coverage) : "—"}
                      </td>
                      <td className="px-3 h-9 text-right tabular">{s.freshness ?? "—"}</td>
                      <td className="px-3 h-9 text-right tabular text-muted-foreground">
                        {s.lastUpdate ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          <Panel className="col-span-12 xl:col-span-5">
            <PanelHeader
              title="Warnings"
              actions={
                <span className="tabular text-[11px] text-muted-foreground">{warnings.length}</span>
              }
            />
            {warnings.length === 0 ? (
              <EmptyState title="Sem warnings" description="Nenhum alerta ativo no momento." />
            ) : (
              <div className="divide-y divide-border">
                {warnings.map((w, i) => (
                  <div key={i} className="p-3 text-xs">
                    <div className="flex items-center gap-2 mb-1">
                      <HealthBadge status={w.level === "error" ? "error" : "warn"} />
                      {w.source ? <span className="text-muted-foreground">{w.source}</span> : null}
                    </div>
                    <div className="text-foreground/90">{w.message}</div>
                    {w.details ? (
                      <pre className="mt-2 tabular text-[11px] text-muted-foreground max-h-40 overflow-auto">
                        {typeof w.details === "string"
                          ? w.details
                          : JSON.stringify(w.details, null, 2)}
                      </pre>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>
      ) : null}
    </div>
  );
}
