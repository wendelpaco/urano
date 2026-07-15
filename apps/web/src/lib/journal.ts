import { useCallback, useSyncExternalStore } from "react";

export const JOURNAL_KEY = "urano.journal";
export const JOURNAL_EVENT = "urano:journal";

export type JournalKind = "contribution" | "allocate" | "rebalance" | "note";

export type JournalEntry = {
  id: string;
  at: string; // ISO
  kind: JournalKind;
  title: string;
  summary?: string;
  payload?: unknown;
  executed?: boolean | null;
};

let journalCache: JournalEntry[] = [];
let journalRaw: string | null = null;

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `j_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function parseJournal(raw: string | null): JournalEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((x) => {
        if (!x || typeof x !== "object") return null;
        const rec = x as Record<string, unknown>;
        const id = String(rec.id ?? "").trim();
        const at = String(rec.at ?? "").trim();
        const kind = rec.kind;
        const title = String(rec.title ?? "").trim();
        if (!id || !at || !title) return null;
        if (
          kind !== "contribution" &&
          kind !== "allocate" &&
          kind !== "rebalance" &&
          kind !== "note"
        ) {
          return null;
        }
        const entry: JournalEntry = {
          id,
          at,
          kind,
          title,
        };
        if (typeof rec.summary === "string") entry.summary = rec.summary;
        if ("payload" in rec) entry.payload = rec.payload;
        if (rec.executed === true || rec.executed === false || rec.executed === null) {
          entry.executed = rec.executed;
        } else if (rec.executed === undefined) {
          entry.executed = null;
        }
        return entry;
      })
      .filter((x): x is JournalEntry => Boolean(x))
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  } catch {
    return [];
  }
}

/** Stable snapshot for useSyncExternalStore (must not allocate a new array every call). */
function getJournalSnapshot(): JournalEntry[] {
  if (typeof window === "undefined") return journalCache;
  const raw = localStorage.getItem(JOURNAL_KEY);
  if (raw === journalRaw) return journalCache;
  journalRaw = raw;
  journalCache = parseJournal(raw);
  return journalCache;
}

function writeJournal(items: JournalEntry[]) {
  if (typeof window === "undefined") return;
  const sorted = [...items].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const raw = JSON.stringify(sorted);
  localStorage.setItem(JOURNAL_KEY, raw);
  journalRaw = raw;
  journalCache = sorted;
  window.dispatchEvent(new Event(JOURNAL_EVENT));
}

function subscribeJournal(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  const handler = () => onStoreChange();
  window.addEventListener(JOURNAL_EVENT, handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener(JOURNAL_EVENT, handler);
    window.removeEventListener("storage", handler);
  };
}

const EMPTY_JOURNAL: JournalEntry[] = [];

export type AddJournalInput = {
  kind: JournalKind;
  title: string;
  summary?: string;
  payload?: unknown;
  executed?: boolean | null;
};

/** Reactive decision journal backed by `localStorage` (`urano.journal`). */
export function useJournal() {
  const entries = useSyncExternalStore(subscribeJournal, getJournalSnapshot, () => EMPTY_JOURNAL);

  const add = useCallback((input: AddJournalInput): JournalEntry => {
    const title = input.title.trim();
    const entry: JournalEntry = {
      id: newId(),
      at: new Date().toISOString(),
      kind: input.kind,
      title: title || "Sem título",
      executed: input.executed ?? null,
    };
    if (input.summary?.trim()) entry.summary = input.summary.trim();
    if (input.payload !== undefined) entry.payload = input.payload;
    writeJournal([entry, ...getJournalSnapshot()]);
    return entry;
  }, []);

  const remove = useCallback((id: string) => {
    writeJournal(getJournalSnapshot().filter((e) => e.id !== id));
  }, []);

  const setExecuted = useCallback((id: string, executed: boolean | null) => {
    writeJournal(getJournalSnapshot().map((e) => (e.id === id ? { ...e, executed } : e)));
  }, []);

  const clear = useCallback(() => {
    writeJournal([]);
  }, []);

  return { entries, add, remove, setExecuted, clear };
}

/** Imperative helper for one-shot saves outside the journal page. */
export function addJournalEntry(input: AddJournalInput): JournalEntry {
  const title = input.title.trim();
  const entry: JournalEntry = {
    id: newId(),
    at: new Date().toISOString(),
    kind: input.kind,
    title: title || "Sem título",
    executed: input.executed ?? null,
  };
  if (input.summary?.trim()) entry.summary = input.summary.trim();
  if (input.payload !== undefined) entry.payload = input.payload;
  writeJournal([entry, ...getJournalSnapshot()]);
  return entry;
}
