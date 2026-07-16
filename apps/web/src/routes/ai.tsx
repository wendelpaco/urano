import { createFileRoute, Link } from "@tanstack/react-router";
import { Panel, PanelHeader } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useEffect, useRef, useState } from "react";
import {
  Send,
  Sparkles,
  MessageSquare,
  Wallet,
  TrendingUp,
  Compass,
  Info,
  Plus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { asArray, useWallets, type Wallet as WalletData } from "@/lib/queries";
import { apiFetch } from "@/lib/api";
import { fmtBRL, fmtNum, fmtPct } from "@/lib/format";

export const Route = createFileRoute("/ai")({
  head: () => ({
    meta: [{ title: "Copilot — Urano" }],
  }),
  component: AIPage,
});

type Msg = { role: "user" | "assistant"; content: string; at: number };
type Conversation = { id: string; title: string; messages: Msg[] };

const SUGGESTIONS = [
  { icon: Wallet, text: "Onde aportar R$ 3.000?" },
  { icon: TrendingUp, text: "Mostre o ranking de ações" },
  { icon: Compass, text: "Qual o veredito do score?" },
  { icon: Info, text: "Explique o score de PETR4" },
  { icon: Sparkles, text: "Compare PETR4 com VALE3" },
  { icon: Sparkles, text: "Como está o macro (Selic/IPCA)?" },
];

/**
 * Copilot determinístico: roteia intents para endpoints reais da API.
 * Não é LLM — respostas com dados do Urano + limites explícitos do score.
 */
async function copilotReply(text: string): Promise<string> {
  const q = text.trim();
  const lower = q.toLowerCase();

  // Validation / confidence
  if (/veredito|valida|confi|edge|quality|o score (funciona|serve|prediz)/i.test(lower)) {
    const v = await apiFetch<{
      scoreVersion: string;
      verdict: string;
      summary: string;
      validatedAt: string | null;
      topN: {
        n: number;
        avgPortfolio: number;
        avgMarket: number;
        winYears: number;
        totalYears: number;
      } | null;
    }>({ path: "/analysis/validation" });
    return [
      `**Validação do score ${v.scoreVersion}** (veredito: \`${v.verdict}\`)`,
      v.validatedAt ? `Validado em ${v.validatedAt}.` : "",
      "",
      v.summary,
      "",
      v.topN
        ? `Top ${v.topN.n}: ${fmtPct(v.topN.avgPortfolio, true)} a.a. vs universo ${fmtPct(v.topN.avgMarket, true)} a.a. · vitórias ${v.topN.winYears}/${v.topN.totalYears} anos.`
        : "",
      "",
      "O score é uma **heurística experimental**, com validação ponto-no-tempo pendente. Detalhes: /validation",
    ]
      .filter(Boolean)
      .join("\n");
  }

  // Contribution / aporte
  const amountMatch =
    lower.match(/(?:aportar|aporte|investir|alocar)\s*(?:r\$\s*)?(\d[\d.]*)/i) ??
    lower.match(/r\$\s*(\d[\d.]*)/);
  if (/aport|onde (colocar|investir)|o que comprar/i.test(lower) || amountMatch) {
    const raw = amountMatch?.[1]?.replace(/\./g, "") ?? "3000";
    const amount = Number(raw) || 3000;
    type BuyRow = {
      ticker: string;
      quantity?: number;
      total?: number;
      amount?: number;
      reason?: string;
    };
    const res = await apiFetch<{
      buys?: BuyRow[];
      purchases?: BuyRow[];
      warnings?: string[];
      summary?: string;
    }>({
      path: "/analysis/contribution",
      method: "POST",
      body: { amount, profile: "moderado" },
    });
    const buys = asArray<BuyRow>(res.buys ?? res.purchases);
    const lines = [
      `Sugestão de aporte de **${fmtBRL(amount)}** (perfil moderado).`,
      "Score = heurística fundamentalista experimental, **não** preditor de retorno.",
      "",
    ];
    if (buys.length === 0) {
      lines.push("Nenhuma compra cabia no orçamento/critérios.");
    } else {
      lines.push("**Compras sugeridas:**");
      for (const b of buys.slice(0, 8)) {
        lines.push(
          `• ${b.ticker}: ${b.quantity ?? "—"} un · ${fmtBRL(b.total ?? b.amount)}${b.reason ? ` — ${b.reason}` : ""}`,
        );
      }
    }
    if (res.warnings?.length) {
      lines.push("", "**Avisos:**", ...res.warnings.map((w) => `• ${w}`));
    }
    lines.push("", "UI completa: /portfolio/contribution");
    return lines.join("\n");
  }

  // Compare
  const compareTickers = [...q.toUpperCase().matchAll(/\b([A-Z]{4}\d{1,2})\b/g)].map((m) => m[1]!);
  if (/compar/i.test(lower) && compareTickers.length >= 2) {
    const items = asArray<{
      ticker: string;
      score?: number | null;
      peRatio?: number | null;
      dy?: number | null;
      diagnosis?: string;
      error?: string;
    }>(
      await apiFetch({
        path: "/analysis/compare",
        method: "POST",
        body: { tickers: compareTickers.slice(0, 5), type: "stock" },
      }),
    );
    const lines = [`Comparação (${compareTickers.slice(0, 5).join(" vs ")}):`, ""];
    for (const it of items) {
      if (it.error) {
        lines.push(`• ${it.ticker}: ${it.error}`);
        continue;
      }
      lines.push(
        `• **${it.ticker}** score ${fmtNum(it.score)} · P/L ${fmtNum(it.peRatio)} · DY ${fmtPct(it.dy, true)}`,
      );
      if (it.diagnosis) lines.push(`  ${it.diagnosis}`);
    }
    lines.push("", "UI: /market/compare");
    return lines.join("\n");
  }

  // Explain ticker
  const tickerMatch = q.toUpperCase().match(/\b([A-Z]{4}\d{1,2})\b/);
  if (
    tickerMatch &&
    (/explic|score|analis|como (está|esta)|o que ach/i.test(lower) ||
      lower.includes(tickerMatch[1]!.toLowerCase()))
  ) {
    const ticker = tickerMatch[1]!;
    const isFii = ticker.endsWith("11");
    const path = isFii ? `/analysis/fiis/${ticker}` : `/analysis/stocks/${ticker}`;
    const data = await apiFetch<Record<string, unknown>>({ path });
    const score = (data.score as number | undefined) ?? null;
    const name = (data.name as string | undefined) ?? ticker;
    const diagnosis =
      (data.diagnosis as string | undefined) ?? (data.explanation as string | undefined);
    const validation = await apiFetch<{ verdict: string; summary: string }>({
      path: "/analysis/validation",
    }).catch(() => null);

    return [
      `**${ticker}** — ${name}`,
      `Score: **${score ?? "—"}** (${isFii ? "FII" : "ação"})`,
      diagnosis ? `\n${diagnosis}` : "",
      "",
      validation
        ? `Contexto do motor (${validation.verdict}): ${validation.summary.slice(0, 280)}…`
        : "Score = qualidade fundamentalista, não retorno esperado.",
      "",
      `Research: /research/${isFii ? "fii" : "stock"}/${ticker}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  // Ranking
  if (/ranking|melhores|top\s*\d*/i.test(lower)) {
    const type = /fii/i.test(lower) ? "fii" : "stock";
    const res = await apiFetch<
      | { data?: Array<{ ticker: string; score?: number; name?: string }> }
      | Array<{ ticker: string; score?: number; name?: string }>
    >({
      path: "/analysis/ranking",
      query: { type, limit: 10 },
    });
    const rows = asArray<{ ticker: string; score?: number; name?: string }>(res);
    const lines = [
      `Top 10 ${type === "fii" ? "FIIs" : "ações"} por score de qualidade:`,
      "",
      ...rows
        .slice(0, 10)
        .map(
          (r, i) =>
            `${i + 1}. ${r.ticker} — score ${fmtNum(r.score)}${r.name ? ` (${r.name})` : ""}`,
        ),
      "",
      "Lembrete: ranking por qualidade filtrada, não por retorno esperado.",
      "UI: /market",
    ];
    return lines.join("\n");
  }

  // Macro
  if (/macro|selic|ipca|câmbio|cambio|juros/i.test(lower)) {
    const res = await apiFetch<{
      data?: Array<{ code: string; name: string; latest: { value: number; date: string } | null }>;
    }>({
      path: "/macro",
    });
    const inds = asArray(res.data ?? res);
    const lines = ["Indicadores macro (BCB):", ""];
    for (const ind of inds) {
      const latest = (ind as { latest?: { value: number; date: string } | null; name?: string })
        .latest;
      const name = (ind as { name?: string }).name ?? "—";
      lines.push(`• ${name}: ${latest ? `${fmtNum(latest.value)} (${latest.date})` : "—"}`);
    }
    lines.push("", "UI: /market/macro");
    return lines.join("\n");
  }

  // Default help
  return [
    "Sou o **Copilot Urano** (roteador de dados, não um LLM genérico).",
    "Posso usar a API real para:",
    "• **Aporte** — “Onde aportar R$ 3.000?”",
    "• **Ranking** — “Mostre o ranking de ações/FIIs”",
    "• **Comparar** — “Compare PETR4 com VALE3”",
    "• **Explicar ticker** — “Explique o score de WEGE3”",
    "• **Validação** — “Qual o veredito do score?”",
    "• **Macro** — “Como está a Selic/IPCA?”",
    "",
    "O score é uma **heurística experimental**; a validação ponto-no-tempo está pendente e ele não prediz retorno.",
  ].join("\n");
}

function AIPage() {
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wallets = useWallets();

  useEffect(() => {
    if (convs.length === 0) {
      const c: Conversation = { id: crypto.randomUUID(), title: "Nova conversa", messages: [] };
      setConvs([c]);
      setActiveId(c.id);
    }
  }, [convs.length]);

  const active = convs.find((c) => c.id === activeId);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [active?.messages.length, pending]);

  const send = async (text: string) => {
    if (!active || !text.trim() || pending) return;
    const userMsg: Msg = { role: "user", content: text.trim(), at: Date.now() };
    setConvs((cs) =>
      cs.map((c) =>
        c.id === active.id
          ? {
              ...c,
              title: c.messages.length === 0 ? text.slice(0, 40) : c.title,
              messages: [...c.messages, userMsg],
            }
          : c,
      ),
    );
    setInput("");
    setPending(true);
    try {
      const content = await copilotReply(text.trim());
      const reply: Msg = { role: "assistant", content, at: Date.now() };
      setConvs((cs) =>
        cs.map((c) => (c.id === active.id ? { ...c, messages: [...c.messages, reply] } : c)),
      );
    } catch (e) {
      const reply: Msg = {
        role: "assistant",
        content: `Falha ao consultar a API: ${(e as Error).message}\n\nConfira Base URL e API key em Settings.`,
        at: Date.now(),
      };
      setConvs((cs) =>
        cs.map((c) => (c.id === active.id ? { ...c, messages: [...c.messages, reply] } : c)),
      );
    } finally {
      setPending(false);
    }
  };

  const newConversation = () => {
    const c: Conversation = { id: crypto.randomUUID(), title: "Nova conversa", messages: [] };
    setConvs((cs) => [c, ...cs]);
    setActiveId(c.id);
  };

  return (
    <div className="flex h-[calc(100vh-88px)]">
      <div className="hidden md:flex w-[220px] shrink-0 flex-col border-r border-border bg-surface">
        <div className="p-2 border-b border-border">
          <Button variant="outline" className="w-full h-8" onClick={newConversation}>
            <Plus className="h-3.5 w-3.5 mr-1.5" /> Nova conversa
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          <div className="px-2 py-1 text-[9px] uppercase tracking-widest text-muted-foreground/70 font-semibold">
            Histórico
          </div>
          {convs.map((c) => (
            <button
              key={c.id}
              onClick={() => setActiveId(c.id)}
              className={cn(
                "w-full text-left px-2 py-1.5 rounded text-xs truncate transition-colors flex items-center gap-2",
                activeId === c.id
                  ? "bg-surface-3 text-foreground"
                  : "text-muted-foreground hover:bg-surface-2",
              )}
            >
              <MessageSquare className="h-3 w-3 shrink-0" />
              {c.title}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 flex flex-col min-w-0">
        <div className="px-4 py-3 border-b border-border bg-surface flex items-center justify-between">
          <div>
            <div className="text-[10px] font-mono uppercase tracking-widest text-primary">
              Urano Copilot
            </div>
            <div className="text-sm font-semibold">{active?.title ?? "—"}</div>
          </div>
          <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground border border-border rounded px-1.5 py-0.5">
            Dados reais · sem LLM
          </span>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          {active?.messages.length === 0 ? (
            <div className="max-w-2xl mx-auto py-12 px-6 text-center">
              <div className="mx-auto h-10 w-10 rounded-full bg-primary/15 grid place-items-center mb-4">
                <Sparkles className="h-5 w-5 text-primary" />
              </div>
              <h2 className="text-xl font-semibold">Como posso ajudar?</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Consulto ranking, aporte, comparação, macro e validação do score via API.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-8 text-left">
                {SUGGESTIONS.map((s, i) => {
                  const Icon = s.icon;
                  return (
                    <button
                      key={i}
                      onClick={() => void send(s.text)}
                      className="group flex items-start gap-2.5 rounded border border-border bg-surface hover:bg-surface-2 p-3 transition-colors"
                    >
                      <Icon className="h-3.5 w-3.5 mt-0.5 text-primary" />
                      <span className="text-xs">{s.text}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto py-6 px-4 space-y-4">
              {active?.messages.map((m, i) => (
                <div key={i} className={cn("flex gap-3", m.role === "user" && "justify-end")}>
                  {m.role === "assistant" ? (
                    <div className="h-6 w-6 rounded bg-primary/15 grid place-items-center shrink-0">
                      <Sparkles className="h-3 w-3 text-primary" />
                    </div>
                  ) : null}
                  <div
                    className={cn(
                      "rounded-md px-3 py-2 text-sm leading-relaxed max-w-[80%] whitespace-pre-wrap",
                      m.role === "user"
                        ? "bg-primary/15 border border-primary/30 text-foreground"
                        : "bg-surface border border-border text-foreground/90",
                    )}
                  >
                    {m.content}
                  </div>
                </div>
              ))}
              {pending ? (
                <div className="flex gap-3">
                  <div className="h-6 w-6 rounded bg-primary/15 grid place-items-center shrink-0">
                    <Sparkles className="h-3 w-3 text-primary animate-pulse" />
                  </div>
                  <div className="rounded-md px-3 py-2 text-sm text-muted-foreground border border-border bg-surface">
                    Consultando API…
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>

        <div className="border-t border-border bg-surface p-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
            className="max-w-3xl mx-auto flex items-end gap-2"
          >
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ex.: Onde aportar R$ 2.000? Compare PETR4 e VALE3…"
              rows={1}
              className="resize-none min-h-9 h-9 max-h-40 py-2"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
            />
            <Button type="submit" size="sm" className="h-9" disabled={pending}>
              <Send className="h-3.5 w-3.5" />
            </Button>
          </form>
          <div className="max-w-3xl mx-auto text-[10px] text-muted-foreground mt-1.5 text-center">
            Roteador de dados · score experimental ·{" "}
            <Link to="/validation" className="underline-offset-2 hover:underline">
              validação
            </Link>
          </div>
        </div>
      </div>

      <div className="hidden lg:flex w-[260px] shrink-0 flex-col border-l border-border bg-surface">
        <div className="px-3 py-2 border-b border-border text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">
          Contexto
        </div>
        <div className="p-3 space-y-3 overflow-y-auto">
          <Panel>
            <PanelHeader title="Suas carteiras" />
            <div className="p-2 space-y-1">
              {asArray(wallets.data).length === 0 ? (
                <div className="text-[11px] text-muted-foreground px-2 py-1">Nenhuma carteira</div>
              ) : (
                asArray<WalletData>(wallets.data).map((w) => (
                  <div key={w.id} className="flex items-center justify-between text-xs px-2 py-1">
                    <span className="truncate">{w.name ?? `#${w.id}`}</span>
                  </div>
                ))
              )}
            </div>
          </Panel>
          <div className="text-[11px] text-muted-foreground leading-relaxed px-1">
            Atalhos:{" "}
            <Link to="/portfolio/contribution" className="text-primary hover:underline">
              aportes
            </Link>
            ,{" "}
            <Link to="/market/compare" className="text-primary hover:underline">
              comparador
            </Link>
            ,{" "}
            <Link to="/validation" className="text-primary hover:underline">
              validação
            </Link>
            .
          </div>
        </div>
      </div>
    </div>
  );
}
