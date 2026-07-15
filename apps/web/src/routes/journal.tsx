import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState, type FormEvent } from "react";
import { BookMarked, Check, Circle, HelpCircle, NotebookPen, Trash2 } from "lucide-react";
import { Panel, PanelHeader, SectionHeader } from "@/components/app/primitives";
import { EmptyState } from "@/components/app/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { JOURNAL_KEY, useJournal, type JournalEntry, type JournalKind } from "@/lib/journal";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/journal")({
  head: () => ({ meta: [{ title: "Diário de decisões" }] }),
  component: JournalPage,
});

const KIND_LABEL: Record<JournalKind, string> = {
  contribution: "Aporte",
  allocate: "Alocação",
  rebalance: "Rebalance",
  note: "Nota",
};

const KIND_TONE: Record<JournalKind, string> = {
  contribution: "bg-sky-500/15 text-sky-400 border-sky-500/30",
  allocate: "bg-violet-500/15 text-violet-400 border-violet-500/30",
  rebalance: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  note: "bg-muted text-muted-foreground border-border",
};

function formatAt(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function nextExecuted(current: boolean | null | undefined): boolean | null {
  // null → true → false → null
  if (current === null || current === undefined) return true;
  if (current === true) return false;
  return null;
}

function executedLabel(v: boolean | null | undefined): string {
  if (v === true) return "Executado";
  if (v === false) return "Não executado";
  return "Pendente";
}

function ExecutedIcon({ value }: { value: boolean | null | undefined }) {
  if (value === true) return <Check className="h-3.5 w-3.5 text-positive" />;
  if (value === false) return <Circle className="h-3.5 w-3.5 text-negative" />;
  return <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" />;
}

function JournalPage() {
  const { entries, add, remove, setExecuted } = useJournal();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  const countByKind = useMemo(() => {
    const m: Record<JournalKind, number> = {
      contribution: 0,
      allocate: 0,
      rebalance: 0,
      note: 0,
    };
    for (const e of entries) m[e.kind] += 1;
    return m;
  }, [entries]);

  function onAddNote(e: FormEvent) {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    add({
      kind: "note",
      title: t,
      summary: body.trim() || undefined,
    });
    setTitle("");
    setBody("");
  }

  return (
    <div className="p-3 md:p-4 space-y-3">
      <SectionHeader
        title="Diário de decisões"
        subtitle="Registre simulações e notas locais — o que considerou e se executou. Persistido só neste navegador."
      />

      <div className="grid grid-cols-12 gap-3">
        <Panel className="col-span-12 lg:col-span-4 h-fit">
          <PanelHeader
            title="Nova nota"
            actions={<NotebookPen className="h-3.5 w-3.5 text-muted-foreground" />}
          />
          <form className="p-4 space-y-3" onSubmit={onAddNote}>
            <div className="space-y-1">
              <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Título
              </Label>
              <Input
                value={title}
                onChange={(ev) => setTitle(ev.target.value)}
                placeholder="Ex.: Revisar FIIs de papel"
                className="h-8"
                maxLength={160}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Detalhe (opcional)
              </Label>
              <Textarea
                value={body}
                onChange={(ev) => setBody(ev.target.value)}
                placeholder="Contexto, tese, risco…"
                className="min-h-[96px] text-sm"
                maxLength={4000}
              />
            </div>
            <Button type="submit" className="w-full" disabled={!title.trim()}>
              <BookMarked className="h-3.5 w-3.5 mr-1.5" />
              Salvar nota
            </Button>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Simulações de aporte e alocação também podem ser salvas com o botão{" "}
              <span className="text-foreground/80">Salvar no journal</span> em cada fluxo. Chave:{" "}
              <code className="px-1 rounded bg-surface-2 font-mono text-[10px]">{JOURNAL_KEY}</code>
            </p>
          </form>
        </Panel>

        <div className="col-span-12 lg:col-span-8 space-y-3">
          <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
            <span className="tabular">
              {entries.length} {entries.length === 1 ? "entrada" : "entradas"}
            </span>
            {(Object.keys(KIND_LABEL) as JournalKind[]).map((k) =>
              countByKind[k] > 0 ? (
                <Badge key={k} variant="outline" className={cn("text-[10px]", KIND_TONE[k])}>
                  {KIND_LABEL[k]} · {countByKind[k]}
                </Badge>
              ) : null,
            )}
          </div>

          {entries.length === 0 ? (
            <Panel>
              <EmptyState
                title="Diário vazio"
                description="Adicione uma nota ou salve o resultado de um aporte / alocação / rebalanceamento."
              />
            </Panel>
          ) : (
            <div className="space-y-2">
              {entries.map((entry) => (
                <JournalCard
                  key={entry.id}
                  entry={entry}
                  onToggleExecuted={() => setExecuted(entry.id, nextExecuted(entry.executed))}
                  onDelete={() => remove(entry.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function JournalCard({
  entry,
  onToggleExecuted,
  onDelete,
}: {
  entry: JournalEntry;
  onToggleExecuted: () => void;
  onDelete: () => void;
}) {
  const [openPayload, setOpenPayload] = useState(false);
  const hasPayload = entry.payload !== undefined && entry.payload !== null;

  return (
    <Panel>
      <div className="flex items-start gap-3 px-3 py-2.5">
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className={cn("text-[10px]", KIND_TONE[entry.kind])}>
              {KIND_LABEL[entry.kind]}
            </Badge>
            <span className="text-[10px] font-mono text-muted-foreground tabular">
              {formatAt(entry.at)}
            </span>
          </div>
          <h3 className="text-sm font-medium text-foreground leading-snug">{entry.title}</h3>
          {entry.summary ? (
            <p className="text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed">
              {entry.summary}
            </p>
          ) : null}
          {hasPayload ? (
            <div className="pt-1">
              <button
                type="button"
                onClick={() => setOpenPayload((v) => !v)}
                className="text-[11px] text-primary hover:underline underline-offset-2"
              >
                {openPayload ? "Ocultar snapshot" : "Ver snapshot"}
              </button>
              {openPayload ? (
                <pre className="mt-1.5 max-h-48 overflow-auto rounded border border-border bg-surface-2 p-2 text-[10px] font-mono text-muted-foreground leading-relaxed">
                  {safeJson(entry.payload)}
                </pre>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-[11px] gap-1.5"
            onClick={onToggleExecuted}
            title="Alternar: pendente → executado → não executado"
          >
            <ExecutedIcon value={entry.executed} />
            {executedLabel(entry.executed)}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-[11px] text-muted-foreground hover:text-negative"
            onClick={onDelete}
            aria-label="Excluir entrada"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </Panel>
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
