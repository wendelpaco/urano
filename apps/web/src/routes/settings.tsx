import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { apiSettings } from "@/lib/api";
import { Panel, PanelHeader, SectionHeader } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertCircle, Check, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { useHealthData } from "@/components/app/HealthBanner";
import { HealthBadge } from "@/components/app/badges";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings — Urano" },
      { name: "description", content: "Configurar API do Urano." },
    ],
  }),
  component: SettingsPage,
});

function SettingsPage() {
  const [baseUrl, setBaseUrl] = useState("");
  const [key, setKey] = useState("");
  const [authMsg, setAuthMsg] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setBaseUrl(apiSettings.getBaseUrl());
    setKey(apiSettings.getKey());
    const m = sessionStorage.getItem("urano.auth.msg");
    if (m) {
      setAuthMsg(m);
      sessionStorage.removeItem("urano.auth.msg");
    }
  }, []);

  const health = useHealthData();

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    apiSettings.setBaseUrl(baseUrl);
    apiSettings.setKey(key);
    setSaved(true);
    toast.success("Configurações salvas");
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="p-4 md:p-6 max-w-4xl">
      <SectionHeader
        title="Settings"
        subtitle="Configurações locais desta sessão. Nenhum dado é enviado a terceiros."
      />

      {authMsg ? (
        <div className="mb-4 flex items-start gap-2 rounded border border-negative/40 bg-negative/10 p-3 text-sm">
          <AlertCircle className="h-4 w-4 text-negative mt-0.5" />
          <div>
            <div className="font-semibold text-negative">Autenticação inválida (401)</div>
            <div className="text-muted-foreground mt-0.5">{authMsg}</div>
            <div className="text-muted-foreground text-xs mt-1">
              Corrija a API Key abaixo e salve para continuar.
            </div>
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Panel className="lg:col-span-2">
          <PanelHeader title="Conexão com a API" />
          <form onSubmit={save} className="p-4 space-y-4">
            <div className="space-y-1.5">
              <Label
                htmlFor="baseUrl"
                className="text-xs uppercase tracking-wider text-muted-foreground"
              >
                API Base URL
              </Label>
              <Input
                id="baseUrl"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.urano.example.com"
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-[11px] text-muted-foreground">
                Endereço base do backend Urano. Todas as chamadas serão feitas a partir deste host.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label
                htmlFor="key"
                className="text-xs uppercase tracking-wider text-muted-foreground"
              >
                API Key
              </Label>
              <Input
                id="key"
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="sk-…"
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-[11px] text-muted-foreground">
                Enviada como <code className="px-1 rounded bg-surface-2">x-api-key</code> em cada
                requisição. Guardada apenas em{" "}
                <code className="px-1 rounded bg-surface-2">localStorage</code>.
              </p>
            </div>

            <div className="flex items-center gap-2 pt-2">
              <Button type="submit">
                {saved ? (
                  <>
                    <Check className="h-3.5 w-3.5 mr-1.5" /> Salvo
                  </>
                ) : (
                  "Salvar configurações"
                )}
              </Button>
              <Button type="button" variant="outline" onClick={() => health.refetch()}>
                Testar conexão
              </Button>
            </div>
          </form>
        </Panel>

        <Panel>
          <PanelHeader title="Status da API" />
          <div className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Endpoint</span>
              <HealthBadge
                status={
                  health.isLoading
                    ? "warn"
                    : health.isError
                      ? "error"
                      : (health.data?.status ?? "ok")
                }
              />
            </div>
            <div className="text-[11px] text-muted-foreground break-all font-mono">
              {baseUrl || "não configurado"}
            </div>
            {health.isError ? (
              <div className="text-xs text-negative">{(health.error as Error).message}</div>
            ) : null}
            {health.data?.sources?.length ? (
              <div className="space-y-1.5 pt-2 border-t border-border">
                {health.data.sources.map((s) => (
                  <div key={s.name} className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">{s.name}</span>
                    <HealthBadge status={s.status ?? "ok"} />
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </Panel>
      </div>

      <div className="mt-4 text-[11px] text-muted-foreground flex items-center gap-1">
        <ExternalLink className="h-3 w-3" />
        Todas as configurações são armazenadas localmente no seu navegador.
      </div>
    </div>
  );
}
