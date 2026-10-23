/**
 * Share answers kept for a moment (#227): twenty open consoles showing one panel cost one read.
 * An answer lasts until its next bar starts, or 30 seconds, whichever is sooner. A change to a
 * share or its revoke drops its answers.
 */

type Entry = { body: unknown; until: number };

const entries = new Map<string, Map<string, Entry>>();
const maxPerShare = 500;
export const maxCacheMs = 30_000;

/** How long an answer read now holds: to the next bar boundary, at most 30s, at least 1s. */
export function cacheMs(now: number, stepMs?: number): number {
  if (!stepMs || stepMs <= 0) {
    return maxCacheMs;
  }
  const toBoundary = Math.ceil((now + 1) / stepMs) * stepMs - now;
  return Math.max(1_000, Math.min(maxCacheMs, toBoundary));
}

export function readShareCache(shareId: string, key: string, now = Date.now()): { body: unknown; ageMs: number; leftMs: number } | null {
  const entry = entries.get(shareId)?.get(key);
  if (!entry || entry.until <= now) {
    return null;
  }
  return { body: entry.body, ageMs: 0, leftMs: entry.until - now };
}

export function writeShareCache(shareId: string, key: string, body: unknown, ms: number, now = Date.now()): void {
  let mine = entries.get(shareId);
  if (!mine) {
    mine = new Map();
    entries.set(shareId, mine);
  }
  if (mine.size >= maxPerShare) {
    for (const [k, e] of mine) {
      if (e.until <= now) mine.delete(k);
    }
    if (mine.size >= maxPerShare) {
      mine.delete(mine.keys().next().value!);
    }
  }
  mine.set(key, { body, until: now + ms });
}

export function dropShareCache(shareId: string): void {
  entries.delete(shareId);
}

/** A read's key: its path and its query, sorted, so the same panel asked twice is one entry. */
export function shareCacheKey(path: string, query: Record<string, string>): string {
  return `${path}?${Object.entries(query)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&")}`;
}
