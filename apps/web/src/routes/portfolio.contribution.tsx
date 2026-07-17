import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
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
import { useEffect, useMemo, useState } from "react";
import { ErrorState, EmptyState } from "@/components/app/states";
import { ScoreBadge, StanceBadge, TickerBadge } from "@/components/app/badges";
import { fmtBRL, fmtPct } from "@/lib/format";
import {
  asArray,
  useWallet,
  useWallets,
  type Position,
  type Wallet,
} from "@/lib/queries";
import {
  loadWalletQuantities,
  positionsFromTickers,
  saveWalletQuantities,
  type QtyMap,
} from "@/lib/wallet-positions";
import { addJournalEntry } from "@/lib/journal";
import {
  AlertTriangle,
  BookMarked,
  Sparkles,
  Wallet as WalletIcon,
  Filter,
} from "lucide-react";
import { toast } from "sonner";

const searchSchema = z.object({
  walletId: fallback(z.string(), "").default(""),
  amount: fallback(z.string(), "3000").default("3000"),
  profile: fallback(
    z.enum(["conservador", "moderado", "agressivo"]),
    "moderado",
  ).default("moderado"),
  onlyTypes: fallback(z.enum(["all", "stock", "fii"]), "all").default("all"),
  /** Modo iniciante: ignora posições mesmo com carteira. */
  fromScratch: fallback(z.enum(["0", "1"]), "0").default("0"),
});

export const Route = createFileRoute("/portfolio/contribution")({
  validateSearch: zodValidator(searchSchema),
  head: () => ({ meta: [{ title: "Simulador de aporte" }] }),
  component: ContributionPage,
});

type ContributionBuy = {
  ticker: string;
  quantity?: number;
  qty?: number;
  price?: number;
  unitPrice?: number;
  total?: number;
  value?: number;
  cost?: number;
  weight?: number;
  reason?: string;
  justification?: string;
  why?: string[];
  score?: number;
  name?: string;
  assetType?: string;
  stance?: string;
  stanceLabel?: string;
  ifNotHolding?: string;
};

type ContributionDiscard = {
  ticker: string;
  reason?: string;
  justification?: string;
  why?: string | string[];
};

type ContributionResult = {
  summary?: string;
  justification?: string;
  amount?: number;
  buys?: ContributionBuy[];
  purchases?: ContributionBuy[];
  recommendations?: ContributionBuy[];
  discards?: ContributionDiscard[];
  rejected?: ContributionDiscard[];
  skipped?: ContributionDiscard[];
  totals?: { invested?: number; remaining?: number; portfolioValueBefore?: number };
  warnings?: string[];
};

function ContributionPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const [amount, setAmount] = useState(search.amount || "3000");
  const [profile, setProfile] = useState<"conservador" | "moderado" | "agressivo">(
    search.profile || "moderado",
  );
  const [onlyTypes, setOnlyTypes] = useState<"all" | "stock" | "fii">(
    search.onlyTypes || "all",
  );
  const [excludeSectors, setExcludeSectors] = useState("");
  const [walletId, setWalletId] = useState(search.walletId || "");
  const [fromScratch, setFromScratch] = useState(search.fromScratch === "1");
  const [manualPositions, setManualPositions] = useState("");
  const [qtyMap, setQtyMap] = useState<QtyMap>({});

  const walletsQ = useWallets();
  const wallets = asArray<Wallet>(walletsQ.data);
  const walletQ = useWallet(walletId || undefined);
  const walletAssets = asArray<Position>(
    walletQ.data?.assets ?? walletQ.data?.positions,
  );
  const walletTickers = useMemo(
    () =>
      walletAssets
        .map((a) => (a.ticker ?? "").toUpperCase())
        .filter((t) => t.length >= 4),
    [walletAssets],
  );

  // Sync search → state when navigating with query
  useEffect(() => {
    if (search.amount) setAmount(search.amount);
    if (search.profile) setProfile(search.profile);
    if (search.onlyTypes) setOnlyTypes(search.onlyTypes);
    if (search.walletId) setWalletId(search.walletId);
    setFromScratch(search.fromScratch === "1");
  }, [search.amount, search.profile, search.onlyTypes, search.walletId, search.fromScratch]);

  // Prefer quantity from API; localStorage só preenche buracos legados
  useEffect(() => {
    if (!walletId) {
      setQtyMap({});
      return;
    }
    const stored = loadWalletQuantities(walletId);
    const merged: QtyMap = {};
    for (const a of walletAssets) {
      const t = (a.ticker ?? "").toUpperCase();
      if (!t) continue;
      const apiQ = a.quantity ?? a.qty;
      if (typeof apiQ === "number" && Number.isFinite(apiQ) && apiQ >= 0) {
        merged[t] = apiQ;
      } else if (stored[t] != null) {
        merged[t] = stored[t]!;
      }
    }
    setQtyMap(merged);
  }, [walletId, walletAssets]);

  // Auto-select first wallet if none
  useEffect(() => {
    if (!walletId && wallets.length === 1 && wallets[0]?.id != null) {
      setWalletId(String(wallets[0].id));
    }
  }, [wallets, walletId]);

  const setQty = (ticker: string, raw: string) => {
    const t = ticker.toUpperCase();
    const n = Number(raw.replace(",", "."));
    setQtyMap((prev) => {
      const next = { ...prev };
      if (!Number.isFinite(n) || n < 0) delete next[t];
      else next[t] = n;
      if (walletId) saveWalletQuantities(walletId, next);
      return next;
    });
  };

  /** Persiste qty na API se o ativo tiver id. */
  const persistQtyToApi = async (ticker: string, quantity: number) => {
    const asset = walletAssets.find(
      (a) => (a.ticker ?? "").toUpperCase() === ticker.toUpperCase(),
    );
    if (!asset?.id || !walletId) return;
    try {
      await apiFetch({
        path: `/wallets/${walletId}/assets/${asset.id}`,
        method: "PATCH",
        body: { quantity },
      });
    } catch {
      /* local draft still used for this simulation */
    }
  };

  const resolvedPositions = useMemo(() => {
    if (fromScratch) return [] as Array<{ ticker: string; quantity: number }>;

    if (walletId && walletTickers.length > 0) {
      return positionsFromTickers(walletTickers, qtyMap);
    }

    // Fallback manual "PETR4:100"
    return manualPositions
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .flatMap((part) => {
        const [t, q] = part.split(":").map((x) => x.trim());
        const ticker = (t ?? "").toUpperCase();
        const quantity = Number(q);
        if (ticker.length < 4 || !Number.isFinite(quantity) || quantity <= 0) return [];
        return [{ ticker, quantity }];
      });
  }, [fromScratch, walletId, walletTickers, qtyMap, manualPositions]);

  const missingQty =
    !fromScratch &&
    walletId &&
    walletTickers.length > 0 &&
    walletTickers.some((t) => !(qtyMap[t] > 0));

  const run = useMutation({
    mutationFn: async () => {
      if (!fromScratch && walletId && walletTickers.length > 0 && missingQty) {
        throw new Error(
          "Informe a quantidade de cada ativo da carteira (ou marque “Começar do zero”).",
        );
      }
      if (!fromScratch && !walletId && manualPositions.trim()) {
        // validate manual
        for (const part of manualPositions.split(",").map((s) => s.trim()).filter(Boolean)) {
          const [t, q] = part.split(":").map((x) => x.trim());
          const ticker = (t ?? "").toUpperCase();
          const quantity = Number(q);
          if (ticker.length < 4) {
            throw new Error(`Ticker inválido em "${part}". Use TICKER:quantidade.`);
          }
          if (!Number.isFinite(quantity) || quantity <= 0) {
            throw new Error(`Quantidade inválida para ${ticker}.`);
          }
        }
      }

      const body = {
        amount: Number(amount),
        profile,
        onlyTypes: onlyTypes === "all" ? undefined : [onlyTypes],
        excludeSectors: excludeSectors
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        positions: resolvedPositions,
      };
      return apiFetch<ContributionResult>({
        path: "/analysis/contribution",
        method: "POST",
        body,
      });
    },
  });

  const result: ContributionResult = run.data ?? {};
  const amountNum = Number(amount) || result.amount || 0;
  const buysRaw = asArray<ContributionBuy>(
    result.buys ?? result.purchases ?? result.recommendations,
  );
  const buys = buysRaw.map((b) => {
    const unit = b.price ?? b.unitPrice;
    const total = b.total ?? b.value ?? b.cost;
    const weight =
      b.weight ??
      (typeof total === "number" && amountNum > 0 ? (total / amountNum) * 100 : undefined);
    return { ...b, price: unit, total, weight };
  });
  const discards = asArray<ContributionDiscard>(
    result.discards ?? result.rejected ?? result.skipped,
  ).map((d) => ({
    ...d,
    reason: Array.isArray(d.why)
      ? d.why.join(" · ")
      : (d.reason ?? d.justification ?? (typeof d.why === "string" ? d.why : undefined)),
  }));

  const beginner = fromScratch || resolvedPositions.length === 0;

  return (
    <div className="p-3 md:p-4 space-y-3">
      <SectionHeader
        title="Simulador de aporte"
        subtitle={
          beginner
            ? "Primeiro investimento ou carteira vazia: o Urano sugere onde colocar o dinheiro com base no filtro de qualidade."
            : "Usa sua carteira para respeitar concentração e diversificar o novo aporte."
        }
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to="/market/screener" search={{ type: "stock", scoreMin: "70", sortBy: "score" }}>
              <Filter className="h-3.5 w-3.5 mr-1.5" />
              Screener (presets)
            </Link>
          </Button>
        }
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
            <Field label="Carteira">
              <Select
                value={walletId || "none"}
                onValueChange={(v) => {
                  const id = v === "none" ? "" : v;
                  setWalletId(id);
                  navigate({
                    search: (p) => ({ ...p, walletId: id }),
                    replace: true,
                  });
                }}
              >
                <SelectTrigger className="h-8">
                  <SelectValue placeholder="Nenhuma (do zero)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Nenhuma — primeiro aporte</SelectItem>
                  {wallets.map((w) => (
                    <SelectItem key={String(w.id)} value={String(w.id)}>
                      {w.name ?? `Carteira ${w.id}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {walletsQ.isLoading ? (
                <p className="text-[10px] text-muted-foreground">Carregando carteiras…</p>
              ) : null}
              {wallets.length === 0 && !walletsQ.isLoading ? (
                <p className="text-[10px] text-muted-foreground">
                  Nenhuma carteira ainda.{" "}
                  <Link to="/portfolio" className="text-primary underline-offset-2 hover:underline">
                    Criar em Portfólio
                  </Link>{" "}
                  ou simule do zero.
                </p>
              ) : null}
            </Field>

            <label className="flex items-start gap-2 rounded border border-border/80 bg-surface-2/40 p-2 cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={fromScratch}
                onChange={(e) => {
                  setFromScratch(e.target.checked);
                  navigate({
                    search: (p) => ({
                      ...p,
                      fromScratch: e.target.checked ? "1" : "0",
                    }),
                    replace: true,
                  });
                }}
              />
              <span className="text-xs leading-snug">
                <span className="font-medium text-foreground">Começar do zero</span>
                <span className="block text-muted-foreground">
                  Ignora posições atuais — ideal para o primeiro aporte ou simulação limpa.
                </span>
              </span>
            </label>

            <Field label="Valor do aporte (R$)">
              <Input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="font-mono h-8"
                inputMode="numeric"
              />
            </Field>
            <Field label="Perfil">
              <Select
                value={profile}
                onValueChange={(v) =>
                  setProfile(v as "conservador" | "moderado" | "agressivo")
                }
              >
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="conservador">Conservador</SelectItem>
                  <SelectItem value="moderado">Moderado</SelectItem>
                  <SelectItem value="agressivo">Agressivo</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Tipos permitidos">
              <Select
                value={onlyTypes}
                onValueChange={(v) => setOnlyTypes(v as "all" | "stock" | "fii")}
              >
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

            {!fromScratch && walletId && walletTickers.length > 0 ? (
              <div className="space-y-2">
                <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <WalletIcon className="h-3 w-3" />
                  Posições da carteira (qtd)
                </div>
                <p className="text-[10px] text-muted-foreground leading-snug">
                  Edite a quantidade e saia do campo para gravar na carteira (servidor).
                </p>
                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                  {walletTickers.map((t) => (
                    <div key={t} className="flex items-center gap-2">
                      <TickerBadge ticker={t} />
                      <Input
                        value={qtyMap[t] != null ? String(qtyMap[t]) : ""}
                        onChange={(e) => setQty(t, e.target.value)}
                        onBlur={(e) => {
                          const n = Number(e.target.value.replace(",", "."));
                          if (Number.isFinite(n) && n >= 0) void persistQtyToApi(t, n);
                        }}
                        placeholder="qtd"
                        className="h-7 font-mono text-xs flex-1"
                        inputMode="decimal"
                      />
                    </div>
                  ))}
                </div>
                {missingQty ? (
                  <p className="text-[11px] text-warning flex items-start gap-1">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    Preencha as quantidades (salvas na carteira ao sair do campo).
                  </p>
                ) : (
                  <p className="text-[10px] text-muted-foreground">
                    {resolvedPositions.length} posição(ões) — quantidades vêm da API da carteira.
                  </p>
                )}
              </div>
            ) : null}

            {!fromScratch && !walletId ? (
              <Field label="Posições manuais (opcional)">
                <Input
                  value={manualPositions}
                  onChange={(e) => setManualPositions(e.target.value)}
                  placeholder="PETR4:100, VALE3:50"
                  className="h-8 font-mono"
                />
                <p className="text-[10px] text-muted-foreground mt-1">
                  Ou selecione uma carteira acima.
                </p>
              </Field>
            ) : null}

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
              <div className="p-4 space-y-3 text-xs text-muted-foreground leading-relaxed">
                <EmptyState
                  title={beginner ? "Pronto para o primeiro aporte" : "Pronto para simular"}
                  description={
                    beginner
                      ? "Defina o valor e o perfil, depois simule. O Urano escolhe ativos com score de qualidade e explica o porquê de cada um."
                      : "Com as quantidades da carteira, o motor evita concentrar demais no que você já tem."
                  }
                />
                <ol className="list-decimal pl-5 space-y-1">
                  <li>Simule o aporte e leia a postura de cada compra.</li>
                  <li>
                    Abra a research de cada ticker e confira indicadores, peers e riscos.
                  </li>
                  <li>Use o screener com preset “Primeiro aporte” se quiser filtrar antes.</li>
                  <li>Registre a tese no Journal — não invista só porque o score é alto.</li>
                </ol>
              </div>
            </Panel>
          ) : null}
          {run.data ? (
            <>
              {(result.warnings?.length ?? 0) > 0 ? (
                <Panel>
                  <div className="p-3 flex gap-2 text-xs leading-relaxed text-amber-400">
                    <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                    <ul className="list-disc pl-4 space-y-1">
                      {result.warnings?.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </div>
                </Panel>
              ) : null}

              {result.totals ? (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
                  <div className="rounded border border-border px-3 py-2">
                    <div className="text-[10px] uppercase text-muted-foreground">Investido</div>
                    <div className="font-mono font-medium">{fmtBRL(result.totals.invested)}</div>
                  </div>
                  <div className="rounded border border-border px-3 py-2">
                    <div className="text-[10px] uppercase text-muted-foreground">Sobra</div>
                    <div className="font-mono font-medium">{fmtBRL(result.totals.remaining)}</div>
                  </div>
                  {result.totals.portfolioValueBefore != null ? (
                    <div className="rounded border border-border px-3 py-2">
                      <div className="text-[10px] uppercase text-muted-foreground">
                        Carteira antes
                      </div>
                      <div className="font-mono font-medium">
                        {fmtBRL(result.totals.portfolioValueBefore)}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const tickers = buys
                      .map((b) => b.ticker)
                      .filter(Boolean)
                      .slice(0, 6)
                      .join(", ");
                    addJournalEntry({
                      kind: "contribution",
                      title: `Aporte R$ ${amount} · ${profile}${tickers ? ` · ${tickers}` : ""}`,
                      summary:
                        result.summary ??
                        result.justification ??
                        `${buys.length} compra(s) sugerida(s)`,
                      payload: {
                        params: {
                          amount: Number(amount),
                          profile,
                          onlyTypes,
                          excludeSectors,
                          walletId,
                          fromScratch,
                          positions: resolvedPositions,
                        },
                        result,
                      },
                    });
                    toast.success("Salvo no journal");
                  }}
                >
                  <BookMarked className="h-3.5 w-3.5 mr-1.5" />
                  Salvar no journal
                </Button>
              </div>
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
                    <span className="tabular text-[11px] text-muted-foreground">
                      {buys.length}
                    </span>
                  }
                />
                {buys.length === 0 ? (
                  <EmptyState title="Sem sugestões de compra" />
                ) : (
                  <div className="divide-y divide-border/60">
                    {buys.map((b, i) => {
                      const whyList = Array.isArray(b.why)
                        ? b.why
                        : b.reason
                          ? [b.reason]
                          : b.justification
                            ? [b.justification]
                            : [];
                      const assetType =
                        b.assetType === "fii" || /\d{2}$/.test(b.ticker) ? "fii" : "stock";
                      return (
                        <div key={i} className="p-3 space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <Link
                              to="/research/$type/$ticker"
                              params={{ type: assetType, ticker: b.ticker }}
                              className="hover:opacity-80"
                            >
                              <TickerBadge ticker={b.ticker} />
                            </Link>
                            <ScoreBadge score={b.score} size="sm" />
                            <StanceBadge label={b.stanceLabel} />
                            <span className="text-[11px] text-muted-foreground ml-auto tabular">
                              {b.quantity ?? b.qty ?? "—"} × {fmtBRL(b.price ?? b.unitPrice)} ={" "}
                              <span className="text-foreground font-medium">
                                {fmtBRL(b.total ?? b.value ?? b.cost)}
                              </span>
                              {b.weight != null ? ` · ${fmtPct(b.weight, true)}` : ""}
                            </span>
                          </div>
                          {b.ifNotHolding ? (
                            <p className="text-xs text-foreground/90 leading-relaxed">
                              {b.ifNotHolding}
                            </p>
                          ) : null}
                          {whyList.length > 0 ? (
                            <ul className="list-disc pl-4 text-[11px] text-muted-foreground space-y-0.5">
                              {whyList.map((w, j) => (
                                <li key={j}>{w}</li>
                              ))}
                            </ul>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}
              </Panel>
              {discards.length > 0 ? (
                <Panel>
                  <PanelHeader title="Descartados / não aumentados" />
                  <div className="divide-y divide-border">
                    {discards.map((d, i) => (
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
