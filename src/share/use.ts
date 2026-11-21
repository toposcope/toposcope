import type { LogEvent } from "../shared/log-event";

/**
 * What each share was used for (#226): a token bucket per share, and one `logs` row a minute per
 * share that was read, plus one row per refused read with its reason. No viewer IPs: it is a
 * series to search, chart and watch with a monitor, not an audit trail of people.
 */

type Bucket = { tokens: number; at: number };
type Tally = { reads: number; cached: number; refused: number; limited: number; origins: Set<string>; last: number | null };

const buckets = new Map<string, Bucket>();
const tallies = new Map<string, Tally>();
let refusals: LogEvent[] = [];
type PendingUse = Map<string, { reads: number; refused: number; last_read_at: string | null }>;
/** Counts handed to a write that has not ended. */
const writing = new Set<PendingUse>();
/** A flood of refusals in one minute is counted, and at most this many are written as rows. */
const maxRefusalRows = 100;
const maxOrigins = 20;

function tally(name: string): Tally {
  let t = tallies.get(name);
  if (!t) {
    t = { reads: 0, cached: 0, refused: 0, limited: 0, origins: new Set(), last: null };
    tallies.set(name, t);
  }
  return t;
}

function noteOrigin(t: Tally, origin: string | undefined): void {
  if (origin && t.origins.size < maxOrigins) {
    t.origins.add(origin.slice(0, 200));
  }
}

/**
 * Take one read from a share's bucket: `reads_per_minute` deep, refilled at that rate. Returns the
 * seconds to wait when it is empty.
 */
export function takeRead(shareId: string, perMinute: number, now = Date.now()): { ok: true } | { ok: false; retryAfter: number } {
  const ratePerMs = perMinute / 60_000;
  const prev = buckets.get(shareId) ?? { tokens: perMinute, at: now };
  const tokens = Math.min(perMinute, prev.tokens + (now - prev.at) * ratePerMs);
  if (tokens < 1) {
    buckets.set(shareId, { tokens, at: now });
    return { ok: false, retryAfter: Math.max(1, Math.ceil((1 - tokens) / ratePerMs / 1000)) };
  }
  buckets.set(shareId, { tokens: tokens - 1, at: now });
  return { ok: true };
}

export function noteRead(name: string, origin: string | undefined, cached = false, now = Date.now()): void {
  const t = tally(name);
  t.last = now;
  if (cached) {
    t.cached += 1;
  } else {
    t.reads += 1;
  }
  noteOrigin(t, origin);
}

export function noteLimited(name: string, origin: string | undefined): void {
  const t = tally(name);
  t.limited += 1;
  noteOrigin(t, origin);
}

/** A read the share does not allow: counted, and written as its own row with why. */
export function noteRefused(name: string, origin: string | undefined, path: string, reason: string, now = Date.now()): void {
  const t = tally(name);
  t.refused += 1;
  noteOrigin(t, origin);
  if (refusals.length < maxRefusalRows) {
    refusals.push({
      ts: new Date(now).toISOString(),
      service: "toposcope",
      level: "warn",
      message: `share ${name} refused: ${reason}`,
      attrs: { share: name, access: name, kind: "share", status: "refused", path, reason, ...(origin ? { origin } : {}) },
    });
  }
}

/** The rows a minute's use makes, and the counters cleared. */
export function drainUse(now = Date.now()): LogEvent[] {
  const ts = new Date(now).toISOString();
  const rows: LogEvent[] = refusals;
  refusals = [];
  for (const [name, t] of tallies) {
    if (t.reads + t.cached + t.refused + t.limited === 0) {
      continue;
    }
    rows.push({
      ts,
      service: "toposcope",
      level: t.refused + t.limited > 0 ? "warn" : "info",
      message: `share ${name}: ${t.reads} reads, ${t.cached} cached, ${t.refused} refused, ${t.limited} limited`,
      attrs: {
        share: name,
        access: name,
        kind: "share",
        status: "used",
        reads: t.reads,
        cached: t.cached,
        refused: t.refused,
        limited: t.limited,
        origins: [...t.origins].sort().join(" "),
      },
    });
  }
  tallies.clear();
  return rows;
}

/** One write of what was used. Until it ends, the list still counts it: the rows are not readable yet. */
export async function flushUse(write: (rows: LogEvent[]) => Promise<unknown>, now = Date.now()): Promise<void> {
  const held = pendingUse();
  const rows = drainUse(now);
  if (rows.length === 0) {
    return;
  }
  writing.add(held);
  try {
    await write(rows);
  } catch (err) {
    console.error("share use rows not written", err);
  } finally {
    writing.delete(held);
  }
}

/** Once a minute, write what was used. A failed write keeps nothing: it is a series, not a ledger. */
export function startShareUse(write: (rows: LogEvent[]) => Promise<unknown>): () => void {
  const timer = setInterval(() => void flushUse(write), 60_000);
  // Never what keeps a process alive: a test that loads the app, or a stop, exits as before.
  timer.unref?.();
  return () => clearInterval(timer);
}

/** The use not yet readable, per share: this minute's and any being written. The list adds it to the rows. */
export function pendingUse(): PendingUse {
  const out: PendingUse = new Map();
  const add = (name: string, reads: number, refused: number, last: string | null) => {
    const prev = out.get(name);
    out.set(name, {
      reads: (prev?.reads ?? 0) + reads,
      refused: (prev?.refused ?? 0) + refused,
      last_read_at: [prev?.last_read_at ?? null, last].filter((x): x is string => x !== null).sort().at(-1) ?? null,
    });
  };
  for (const batch of writing) {
    for (const [name, t] of batch) {
      add(name, t.reads, t.refused, t.last_read_at);
    }
  }
  for (const [name, t] of tallies) {
    add(name, t.reads + t.cached, t.refused, t.last ? new Date(t.last).toISOString() : null);
  }
  return out;
}

/** For tests. */
export function resetShareUse(): void {
  buckets.clear();
  tallies.clear();
  writing.clear();
  refusals = [];
}
