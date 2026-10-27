import type { LogEvent } from "../shared/log-event";

/**
 * One use-row shape for every way in (#265): `service:toposcope access:<name> kind:token|link|share
 * status:used|refused`. A minute's use is one `used` row per way in that was used; every refusal is
 * its own row with why. Shares keep writing their own rows (they also carry `access:` now).
 * No addresses of the people or machines that called: a series to search and watch, not an audit log.
 */
export type AccessKind = "token" | "link" | "share" | "person";

type Tally = { kind: AccessKind; name: string; used: number; refused: number; last: number | null };
const tallies = new Map<string, Tally>();
let refusals: LogEvent[] = [];
const maxRefusalRows = 100;

function key(kind: AccessKind, name: string): string {
  return `${kind}\u0000${name}`;
}

function tally(kind: AccessKind, name: string): Tally {
  const k = key(kind, name);
  let t = tallies.get(k);
  if (!t) {
    t = { kind, name, used: 0, refused: 0, last: null };
    tallies.set(k, t);
  }
  return t;
}

export function noteAccessUsed(kind: AccessKind, name: string, now = Date.now()): void {
  const t = tally(kind, name);
  t.used += 1;
  t.last = now;
}

export function noteAccessRefused(kind: AccessKind, name: string, reason: string, path: string, now = Date.now()): void {
  const t = tally(kind, name);
  t.refused += 1;
  if (refusals.length < maxRefusalRows) {
    refusals.push({
      ts: new Date(now).toISOString(),
      service: "toposcope",
      level: "warn",
      message: `${kind} ${name} refused: ${reason}`,
      attrs: { access: name, kind, status: "refused", reason, path },
    });
  }
}

export function drainAccessUse(now = Date.now()): LogEvent[] {
  const ts = new Date(now).toISOString();
  const rows = refusals;
  refusals = [];
  for (const t of tallies.values()) {
    if (t.used === 0) {
      continue;
    }
    rows.push({
      ts,
      service: "toposcope",
      level: "info",
      message: `${t.kind} ${t.name}: used ${t.used} times`,
      attrs: { access: t.name, kind: t.kind, status: "used", n: t.used },
    });
  }
  tallies.clear();
  return rows;
}

/** The minute not yet written, per way in. */
export function pendingAccessUse(): Map<string, { used: number; refused: number; last: number | null }> {
  const out = new Map<string, { used: number; refused: number; last: number | null }>();
  for (const t of tallies.values()) {
    out.set(key(t.kind, t.name), { used: t.used, refused: t.refused, last: t.last });
  }
  return out;
}

export function accessKey(kind: AccessKind, name: string): string {
  return key(kind, name);
}

export function startAccessUse(write: (rows: LogEvent[]) => Promise<unknown>): () => void {
  const timer = setInterval(() => {
    const rows = drainAccessUse();
    if (rows.length > 0) {
      write(rows).catch((err) => console.error("access use rows not written", err));
    }
  }, 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** For tests. */
export function resetAccessUse(): void {
  tallies.clear();
  refusals = [];
}
