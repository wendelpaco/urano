/**
 * Persistência canônica de proventos (free source: StatusInvest).
 * Leitura preferencial do DB se fresco; escrita idempotente (upsert).
 */

import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { db } from './connection.ts';
import { dividendEvents } from './schema.ts';
import type { DividendEvent } from '../../core/services/dividends-analyzer.ts';

const FRESH_MS = 24 * 60 * 60 * 1000; // 24h

export async function loadFreshDividends(
  ticker: string,
): Promise<{ events: DividendEvent[]; asOf: string; source: string } | null> {
  const upper = ticker.toUpperCase();
  const since = new Date(Date.now() - FRESH_MS);

  const rows = await db
    .select()
    .from(dividendEvents)
    .where(
      and(
        eq(dividendEvents.ticker, upper),
        gte(dividendEvents.fetchedAt, since),
      ),
    )
    .orderBy(desc(dividendEvents.eventDate));

  if (rows.length === 0) return null;

  const latestFetch = rows.reduce(
    (max, r) => (r.fetchedAt > max ? r.fetchedAt : max),
    rows[0]!.fetchedAt,
  );

  return {
    source: rows[0]!.source,
    asOf: latestFetch.toISOString(),
    events: rows.map((r) => ({
      date: String(r.eventDate),
      value: Number(r.value),
      type: r.type,
    })),
  };
}

/** Upsert batch — ignores conflicts on unique (ticker, date, type, value). */
export async function persistDividends(
  ticker: string,
  events: DividendEvent[],
  source = 'statusinvest',
): Promise<number> {
  if (events.length === 0) return 0;
  const upper = ticker.toUpperCase();
  const now = new Date();
  let written = 0;

  // Chunk to avoid huge multi-row inserts
  const chunkSize = 50;
  for (let i = 0; i < events.length; i += chunkSize) {
    const chunk = events.slice(i, i + chunkSize);
    const values = chunk.map((e) => ({
      ticker: upper,
      eventDate: e.date.slice(0, 10),
      paymentDate: null as string | null,
      value: String(e.value),
      type: e.type,
      source,
      fetchedAt: now,
    }));

    try {
      await db
        .insert(dividendEvents)
        .values(values)
        .onConflictDoUpdate({
          target: [
            dividendEvents.ticker,
            dividendEvents.eventDate,
            dividendEvents.type,
            dividendEvents.value,
          ],
          set: {
            fetchedAt: now,
            source,
          },
        });
      written += chunk.length;
    } catch {
      // Fallback: row-by-row ignore
      for (const v of values) {
        try {
          await db.insert(dividendEvents).values(v).onConflictDoNothing();
          written += 1;
        } catch {
          /* skip */
        }
      }
    }
  }

  // Touch fetched_at on all rows for this ticker so loadFresh works even if no new rows
  if (written === 0 && events.length > 0) {
    await db
      .update(dividendEvents)
      .set({ fetchedAt: now })
      .where(eq(dividendEvents.ticker, upper));
  }

  return written;
}

export async function countDividends(ticker: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(dividendEvents)
    .where(eq(dividendEvents.ticker, ticker.toUpperCase()));
  return row?.n ?? 0;
}
