import { createFileRoute } from "@tanstack/react-router";
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

export const Route = createFileRoute("/ai")({
  head: () => ({
    meta: [{ title: "Copilot — Urano AI" }],
  }),
  component: AIPage,
});

type Msg = { role: "user" | "assistant"; content: string; at: number };
type Conversation = { id: string; title: string; messages: Msg[] };

const SUGGESTIONS = [
  { icon: Wallet, text: "Onde aportar R$ 3.000?" },
  { icon: TrendingUp, text: "Quais ativos estão caros?" },
  { icon: Compass, text: "Minha carteira está concentrada?" },
  { icon: Info, text: "Existe algum setor sobreponderado?" },
  { icon: Sparkles, text: "Compare PETR4 com PRIO3." },
  { icon: Sparkles, text: "Quais FIIs apresentam melhor relação risco/retorno?" },
];

function AIPage() {
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
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
  }, [active?.messages.length]);

  const send = (text: string) => {
    if (!active || !text.trim()) return;
    const userMsg: Msg = { role: "user", content: text.trim(), at: Date.now() };
    // Placeholder response — this page is UI-only; backend integration virá depois.
    const reply: Msg = {
      role: "assistant",
      at: Date.now() + 1,
      content:
        "O copiloto de IA será integrado em breve. Por enquanto esta é uma interface de preview: quando o modelo for conectado, ele responderá com dados reais da sua carteira e do mercado.",
    };
    setConvs((cs) =>
      cs.map((c) =>
        c.id === active.id
          ? {
              ...c,
              title: c.messages.length === 0 ? text.slice(0, 40) : c.title,
              messages: [...c.messages, userMsg, reply],
            }
          : c,
      ),
    );
    setInput("");
  };

  const newConversation = () => {
    const c: Conversation = { id: crypto.randomUUID(), title: "Nova conversa", messages: [] };
    setConvs((cs) => [c, ...cs]);
    setActiveId(c.id);
  };

  return (
    <div className="flex h-[calc(100vh-88px)]">
      {/* History */}
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

      {/* Chat */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="px-4 py-3 border-b border-border bg-surface flex items-center justify-between">
          <div>
            <div className="text-[10px] font-mono uppercase tracking-widest text-primary">
              Urano Copilot
            </div>
            <div className="text-sm font-semibold">{active?.title ?? "—"}</div>
          </div>
          <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground border border-border rounded px-1.5 py-0.5">
            Preview · em breve
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
                Faça perguntas sobre seus ativos, carteira e oportunidades.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-8 text-left">
                {SUGGESTIONS.map((s, i) => {
                  const Icon = s.icon;
                  return (
                    <button
                      key={i}
                      onClick={() => send(s.text)}
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
            </div>
          )}
        </div>

        <div className="border-t border-border bg-surface p-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="max-w-3xl mx-auto flex items-end gap-2"
          >
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Pergunte algo sobre o mercado ou sua carteira…"
              rows={1}
              className="resize-none min-h-9 h-9 max-h-40 py-2"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
            />
            <Button type="submit" size="sm" className="h-9">
              <Send className="h-3.5 w-3.5" />
            </Button>
          </form>
          <div className="max-w-3xl mx-auto text-[10px] text-muted-foreground mt-1.5 text-center">
            Enter para enviar · Shift+Enter para quebra de linha
          </div>
        </div>
      </div>

      {/* Context */}
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
            O copiloto usará o contexto das suas carteiras, ativos favoritos e histórico de análises
            para responder de forma personalizada.
          </div>
        </div>
      </div>
    </div>
  );
}
