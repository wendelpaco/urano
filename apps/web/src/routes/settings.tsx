import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiSettings, pingHealthcheck, apiFetch, ApiError } from "@/lib/api";
import { Panel, PanelHeader, SectionHeader } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertCircle, Check, ExternalLink, Settings2 } from "lucide-react";
import { toast } from "sonner";
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
  const [saveError, setSaveError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    // Migra misconfig antiga (:3333) → same-origin e limpa o campo
    const stored = apiSettings.getStoredBaseUrl();
    if (stored && /:(3333|3000)(\/|$)/.test(stored)) {
      apiSettings.setBaseUrl(""); // same-origin via proxy
      setBaseUrl("");
      toast.message("Base URL corrigida", {
        description: "Removemos a porta da API (:3333). Usando o front (:8080) + proxy.",
      });
    } else {
      setBaseUrl(stored);
    }
    setKey(apiSettings.getKey());
    const m = sessionStorage.getItem("urano.auth.msg");
    if (m) {
      setAuthMsg(m);
      sessionStorage.removeItem("urano.auth.msg");
    }
  }, []);

  // 1) Ping público — define se a API responde (badge principal)
  const ping = useQuery({
    queryKey: ["health", "ping", tick],
    queryFn: () => pingHealthcheck(),
    staleTime: 10_000,
    retry: 1,
    enabled: typeof window !== "undefined",
  });

  // 2) Auth opcional — não bloqueia o status de conexão
  const auth = useQuery({
    queryKey: ["health", "auth", tick, key ? "has-key" : "no-key"],
    queryFn: async (): Promise<"ok" | "missing" | "invalid"> => {
      const k = apiSettings.getKey();
      if (!k) return "missing";
      try {
        await apiFetch({ path: "/health/data" });
        return "ok";
      } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          return e.status === 401 ? "invalid" : "ok";
        }
        throw e;
      }
    },
    staleTime: 10_000,
    retry: 0,
    enabled: typeof window !== "undefined" && ping.isSuccess,
  });

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    try {
      apiSettings.setBaseUrl(baseUrl);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "URL inválida.");
      return;
    }
    setSaveError(null);
    apiSettings.setKey(key);
    setSaved(true);
    toast.success("Configurações salvas");
    setTick((t) => t + 1);
    setTimeout(() => setSaved(false), 1500);
  };

  const effectiveBase = typeof window !== "undefined" ? apiSettings.getBaseUrl() : "";

  const badgeStatus = ping.isLoading
    ? "warn"
    : ping.isError
      ? "error"
      : ping.data?.status === "ok"
        ? "ok"
        : "warn";

  return (
    <div className="p-6 md:p-10 max-w-5xl">
      <div className="flex items-center gap-3 pb-6">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-2 border border-border">
          <Settings2 className="h-5 w-5 text-muted-foreground" />
        </div>
        <SectionHeader
          title="Settings"
          subtitle="Configurações locais desta sessão. Nenhum dado é enviado a terceiros."
        />
      </div>

      {authMsg ? (
        <div className="mb-4 flex items-start gap-2 rounded border border-negative/40 bg-negative/10 p-3 text-sm">
          <AlertCircle className="h-4 w-4 text-negative mt-0.5" />
          <div>
            <div className="font-semibold text-negative">Autenticação inválida (401)</div>
            <div className="text-muted-foreground mt-0.5">{authMsg}</div>
          </div>
        </div>
      ) : null}

      {saveError ? (
        <div className="mb-4 flex items-start gap-2 rounded border border-negative/40 bg-negative/10 p-3 text-sm">
          <AlertCircle className="h-4 w-4 text-negative mt-0.5" />
          <div>
            <div className="font-semibold text-negative">Base URL inválida</div>
            <div className="text-muted-foreground mt-0.5">{saveError}</div>
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Panel className="lg:col-span-2">
          <PanelHeader title="Conexão com a API" />
          <form onSubmit={save} className="p-6 space-y-5">
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
                placeholder="(vazio = mesmo host do front — recomendado)"
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                Em dev: <strong>deixe vazio</strong> (ou{" "}
                <code className="px-1 rounded bg-surface-2">http://localhost:8080</code>). Não use{" "}
                <code className="px-1 rounded bg-surface-2">:3333</code> e não coloque{" "}
                <code className="px-1 rounded bg-surface-2">/v1</code> — o client e o proxy tratam
                isso.
              </p>
              <p className="text-[11px] font-mono text-muted-foreground">
                Efetivo agora: {effectiveBase || "—"}
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
                placeholder="ur_… (bun run key:create em apps/api)"
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-[11px] text-muted-foreground">
                Enviada como <code className="px-1 rounded bg-surface-2">x-api-key</code>.
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
              <Button
                type="button"
                variant="outline"
                disabled={ping.isFetching}
                onClick={() => setTick((t) => t + 1)}
              >
                {ping.isFetching ? "Testando…" : "Testar conexão"}
              </Button>
            </div>
          </form>
        </Panel>

        <Panel>
          <PanelHeader title="Status da API" />
          <div className="p-6 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Conexão</span>
              <HealthBadge status={badgeStatus} />
            </div>
            <div className="text-[11px] text-muted-foreground break-all font-mono">
              {effectiveBase}/v1/healthcheck
            </div>

            {ping.isLoading || ping.isFetching ? (
              <div className="text-xs text-muted-foreground">Testando conexão…</div>
            ) : null}

            {ping.isError ? (
              <div className="text-xs text-negative whitespace-pre-wrap">
                {(ping.error as Error).message}
              </div>
            ) : null}

            {ping.isSuccess ? (
              <div className="space-y-1.5 pt-2 border-t border-border text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">API</span>
                  <span className="text-positive">{ping.data.status}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Database</span>
                  <span>{ping.data.checks?.database ?? "—"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Redis</span>
                  <span>{ping.data.checks?.redis ?? "—"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">API Key</span>
                  <span>
                    {auth.isLoading
                      ? "…"
                      : auth.data === "ok"
                        ? "válida"
                        : auth.data === "invalid"
                          ? "inválida"
                          : "não informada"}
                  </span>
                </div>
              </div>
            ) : null}
          </div>
        </Panel>
      </div>

      <div className="mt-4 text-[11px] text-muted-foreground flex items-center gap-1">
        <ExternalLink className="h-3 w-3" />
        Configurações só no navegador (localStorage).
      </div>
    </div>
  );
}
