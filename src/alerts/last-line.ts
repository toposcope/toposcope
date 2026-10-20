import { searchLogs } from "../query";
import type { LogEvent } from "../shared/log-event";

/**
 * When a search last matched a line (#176): "last line 10:26:41, 37m ago" in Watch and the
 * editor. One row, newest first, through the event page's widening lookback; read at most once
 * per refresh for each query, and after the first read only back to the line it found then.
 */

/** Watch reads every 15s and the header every 30s: a reading this fresh is not read again. */
export const lastLineFreshMs = 25_000;
/** A reading slower than this answers with the one before it, and lands for the next refresh. */
const waitMs = 2_000;
const yearMs = 365 * 24 * 60 * 60_000;

/** A number when found; null when nothing matched in a year; undefined when it could not be read. */
export type LastLine = number | null | undefined;

type Entry = { readAt: number; at: LastLine; pending: Promise<void> | null };

const cache = new Map<string, Entry>();

/** Reads the store; tests swap it. */
export const lastLineStore = {
  newest: (query: string, fromMs: number, toMs: number): Promise<LogEvent[]> =>
    searchLogs({ q: query, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), limit: 1 }),
};

async function readOnce(query: string, now: number, entry: Entry): Promise<void> {
  // A newer line is at or after the one found last time; nothing since means it still is.
  const known = typeof entry.at === "number" ? entry.at : null;
  try {
    const rows = await lastLineStore.newest(query, known ?? now - yearMs, now);
    const ts = rows[0] ? Date.parse(rows[0].ts) : NaN;
    entry.at = Number.isFinite(ts) ? ts : known;
  } catch (err) {
    console.warn("last line not read", err instanceof Error ? err.message : err);
    entry.at = known ?? undefined;
  }
  entry.readAt = now;
}

export async function lastLineAt(query: string, now = Date.now()): Promise<LastLine> {
  let entry = cache.get(query);
  if (entry && now - entry.readAt < lastLineFreshMs) {
    return entry.at;
  }
  if (!entry) {
    if (cache.size > 500) {
      cache.clear();
    }
    entry = { readAt: 0, at: undefined, pending: null };
    cache.set(query, entry);
  }
  const current = entry;
  current.pending ??= readOnce(query, now, current).finally(() => {
    current.pending = null;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    current.pending,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs);
    }),
  ]);
  clearTimeout(timer);
  return current.at;
}

/** Tests start from nothing read. */
export function forgetLastLines(): void {
  cache.clear();
}
