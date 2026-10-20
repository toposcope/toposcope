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
