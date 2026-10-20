import { seriesLabel } from "../query/agg";

/**
 * A monitor (#175): a name, a source, a state and the calls it sends. Shared by the server,
 * which keeps the state, and Watch, which draws it.
 */

/** Where a monitor's results come from: a saved search, new fingerprints, or pushed results (#177). */
export const monitorSources = ["search", "fingerprints", "push"] as const;
export type MonitorSource = (typeof monitorSources)[number];

export function parseSource(value: unknown): MonitorSource | null {
  return typeof value === "string" && (monitorSources as readonly string[]).includes(value)
    ? (value as MonitorSource)
    : null;
}

/** A saved search's series (an alert's `threshold` kind), or new fingerprints after a mark (`first_seen`). */
export function sourceOfKind(kind: "threshold" | "first_seen"): MonitorSource {
  return kind === "first_seen" ? "fingerprints" : "search";
}

export function kindOfSource(source: MonitorSource): "threshold" | "first_seen" {
  return source === "fingerprints" ? "first_seen" : "threshold";
}

export type MonitorState = "ok" | "open";

/**
 * What opens a search monitor (#176): its series at least the threshold (a search that goes
 * loud), or fewer than it (a search that goes quiet).
 */
export const opensWhenIds = ["at_least", "fewer_than"] as const;
export type OpensWhen = (typeof opensWhenIds)[number];

export function parseOpensWhen(value: unknown): OpensWhen | null {
  return typeof value === "string" && (opensWhenIds as readonly string[]).includes(value)
    ? (value as OpensWhen)
    : null;
}

/**
 * Why fewer than cannot read a saved search: a percentile or an average over no rows has no
 * value, and a fixed from/to never moves on. Null when it can.
 */
export function fewerThanProblem(saved: { agg?: string | null; range: string | null }): string | null {
  if (saved.agg && saved.agg.trim().toLowerCase() !== "rate") {
    return `fewer than reads a count or a rate; ${seriesLabel(saved.agg.trim())} over no lines has no value`;
  }
  if (!saved.range) {
    return "fewer than needs a relative window (range=15m), not a fixed from/to";
  }
  return null;
}

/**
 * Why a fewer-than monitor stayed shut on its last pass while its reading said it would open
 * (#176): Toposcope has not been up for one whole window yet, or a linked source that could feed
 * the count is short inside the window, so the count is a floor. A refused or failed reading is
 * the monitor's `last_status`.
 */
export type CantTell =
  | { kind: "starting"; at: number; until: number }
  | { kind: "held"; at: number; sources: Array<{ name: string; state: "behind" | "quiet" | "hole" }> };

export function parseCantTell(raw: string | null | undefined): CantTell | null {
  if (!raw) {
    return null;
  }
  try {
    const value = JSON.parse(raw) as CantTell;
    if (value && typeof value === "object" && (value.kind === "starting" || value.kind === "held")) {
      return value;
    }
  } catch {
    // An unreadable note says nothing.
  }
  return null;
}

/** "starting, up 4m of 15m", "prod-us behind", "a refused reading": why it can't tell, in Watch's words. */
export function cantTellWords(
  m: { cant_tell: CantTell | null; last_status: string | null },
  windowMs: number,
  nowMs: number,
): string | null {
  if (m.last_status === "refused") {
    return "a refused reading";
  }
  if (m.last_status === "error") {
    return "a failed reading";
  }
  const why = m.cant_tell;
  if (!why) {
    return null;
  }
  if (why.kind === "starting") {
    const up = Math.max(0, nowMs - (why.until - windowMs));
    return `starting, up ${formatOpenFor(Math.min(up, windowMs))} of ${formatOpenFor(windowMs)}`;
  }
  const shown = why.sources.slice(0, 2).map((s) => `${s.name} ${s.state === "hole" ? "has a hole" : s.state}`);
  const more = why.sources.length - shown.length;
  return more > 0 ? `${shown.join(", ")} +${more}` : shown.join(", ");
}

/** A result: a fail opens a monitor, the first ok after it resolves it, a warn shows and changes nothing. */
export type MonitorResult = "ok" | "warn" | "fail";

/** How often an open monitor reminds: never, once per its search's window, or every 1h, 4h or 24h. */
export const remindIds = ["off", "window", "1h", "4h", "24h"] as const;
export type RemindId = (typeof remindIds)[number];

/** A new monitor reminds every 4h; an alert that existed before 0.6 keeps calling once per window. */
export const defaultRemind: RemindId = "4h";

const remindFixedMs: Record<"1h" | "4h" | "24h", number> = {
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
};

export function parseRemind(value: unknown): RemindId | null {
  return typeof value === "string" && (remindIds as readonly string[]).includes(value)
    ? (value as RemindId)
    : null;
}

/** Milliseconds between reminders, or null when it does not remind. */
export function remindEveryMs(id: RemindId, windowMs: number): number | null {
  if (id === "off") {
    return null;
  }
  if (id === "window") {
    return windowMs;
  }
  return remindFixedMs[id];
}

/** An open or resolved call that does not go through is tried each pass for this long. */
export const callRetryMs = 60 * 60_000;

/** Stretches kept a monitor; older ones and their calls are dropped. */
export const keptStretches = 200;

/** "fewer than 1", "rate fewer than 0.5", "p99(duration_ms) at least 800": what opens it, in words. */
export function opensWhenWords(opensWhen: OpensWhen, series: string | null, threshold: number): string {
  const n = Number.isInteger(threshold) ? threshold.toLocaleString("en-US") : String(Number(threshold.toPrecision(6)));
  return `${series ? `${series} ` : ""}${opensWhen === "fewer_than" ? "fewer than" : "at least"} ${n}`;
}

/** "45s", "22m", "7h 59m", "24h 2m", "3d 4h": how long a stretch has been open, or lasted. */
export function formatOpenFor(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m`;
  }
  const h = Math.floor(m / 60);
  if (h < 48) {
    const rest = m % 60;
    return rest > 0 ? `${h}h ${rest}m` : `${h}h`;
  }
  const d = Math.floor(h / 24);
  const rest = h % 24;
  return rest > 0 ? `${d}d ${rest}h` : `${d}d`;
}
