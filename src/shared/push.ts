/**
 * Push monitors (#177): a script, a cron job or a box with no logs tells Toposcope how it went,
 * through `POST /v1/checks` (token) or its keyed `/ping/<key>` URL (no token). Shared by ingest,
 * the monitor pass and Watch.
 */
import { formatOpenFor } from "./monitor";
import { parseRangeMs } from "../query/relative";

/** A result: Nagios's ok, warning, critical and unknown. Unknown changes nothing. */
export type CheckStatus = "ok" | "warn" | "fail" | "unknown";

const nagios: readonly CheckStatus[] = ["ok", "warn", "fail", "unknown"];

/** Results in one `POST /v1/checks`. */
export const maxCheckBatch = 500;
/** Push monitors a first result may create; past that a new name is refused. */
export const maxPushMonitors = 500;
/** A ping's POST body is its message, up to 10 KB; the rest is cut. */
export const maxPingBody = 10 * 1024;
/** A result's message, from either route. */
export const maxCheckMessage = 10 * 1024;
export const maxMonitorName = 100;
export const maxCheckUnit = 16;
/**
 * Watch's ticks are kept in SQLite a monitor a minute, the worst result of the minute winning,
 * for 30 days; every result is also a log row, which is the record.
 */
export const keptResultsMs = 30 * 24 * 60 * 60_000;
/** A ping stored at most once a second per key, for its start and for its result each. */
export const pingEveryMs = 1000;

const minuteMs = 60_000;
const hourMs = 60 * minuteMs;
const dayMs = 24 * hourMs;
/** `every` is 30s to 365d; `grace` 0 to 365d. */
export const minEveryMs = 30_000;
export const maxPushSpanMs = 365 * dayMs;

/**
 * `ok`, `warn`, `fail`, or `0`–`3` (a number or its digit), which are Nagios's ok, warning,
 * critical and unknown, so a plugin's exit code is a status. Null for anything else.
 */
export function parseCheckStatus(raw: unknown): CheckStatus | null {
  if (raw === "ok" || raw === "warn" || raw === "fail") {
    return raw;
  }
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^[0-3]$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 3 ? nagios[n]! : null;
}

/** The exit code a numeric status was, for the row's `exit_code`. */
export function exitCodeOfStatus(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 3) {
    return raw;
  }
  return typeof raw === "string" && /^[0-3]$/.test(raw) ? Number(raw) : null;
}

/** `/ping/<key>/<exit code>`, as Healthchecks reads it: 0 is ok, anything else a fail. */
export function pingStatusOfExitCode(code: number): CheckStatus {
  return code === 0 ? "ok" : "fail";
}

/** A result's row level: a fail is an error, a warn a warn, the rest info. */
export function levelOfStatus(status: CheckStatus): "info" | "warn" | "error" {
  return status === "fail" ? "error" : status === "warn" ? "warn" : "info";
}

/** `30s`, `5m`, `1h`, `1d`, `1w`: when the next result is due. Null when it is not one. */
export function parseEvery(raw: unknown): number | null {
  if (typeof raw !== "string") {
    return null;
  }
  const ms = parseRangeMs(raw.trim());
  return ms !== null && ms >= minEveryMs && ms <= maxPushSpanMs ? ms : null;
}

/** `0`, `2m`, `1h`: how long past due before it opens. Null when it is not one. */
export function parseGrace(raw: unknown): number | null {
  if (typeof raw !== "string") {
    return null;
  }
  const text = raw.trim();
  if (/^0(ms|s|m|h|d|w)?$/.test(text)) {
    return 0;
  }
  const ms = parseRangeMs(text);
  return ms !== null && ms <= maxPushSpanMs ? ms : null;
}

/** Without a grace of its own, a monitor waits one more `every` before it opens, at most an hour. */
export function defaultGraceMs(everyMs: number): number {
  return Math.min(everyMs, hourMs);
}

/** `1d`, `7d`, `15m`, `90s`, `0`: a span in its largest whole unit, days at most (18f). */
export function formatSpan(ms: number): string {
  if (ms <= 0) {
    return "0";
  }
  const units: Array<[string, number]> = [
    ["d", dayMs],
    ["h", hourMs],
    ["m", minuteMs],
    ["s", 1000],
  ];
  for (const [unit, size] of units) {
    if (ms % size === 0) {
      return `${ms / size}${unit}`;
    }
  }
  return `${ms}ms`;
}

/**
 * A push monitor's name: what `monitor:<name>` finds in Search. 1–100 characters, no quote and
 * no control character.
 */
export function parsePushName(raw: unknown): string | { error: string } {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (name.length === 0) {
    return { error: "monitor is required" };
  }
  if (name.length > maxMonitorName) {
    return { error: `monitor must be at most ${maxMonitorName} characters` };
  }
  // eslint-disable-next-line no-control-regex
  if (/["\u0000-\u001f\u007f]/.test(name)) {
    return { error: "monitor must have no quote and no control character" };
  }
  return name;
}

/** `monitor:nightly-backup`, or `monitor:"ci-runner check"` when the name needs quotes. */
export function monitorQuery(name: string): string {
  return /^[A-Za-z0-9_][A-Za-z0-9._/@-]*$/.test(name) && !name.endsWith("*")
    ? `monitor:${name}`
    : `monitor:"${name}"`;
}

/** A keyed URL's key: a random UUID. */
export function isPingKey(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

/**
 * A fresh key: a random (version 4) UUID. Built from `getRandomValues`, which a browser has on a
 * plain-http address too, where `randomUUID` is missing.
 */
export function randomPingKey(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** `9f2c…e41a`: a key as Watch may show it, never whole. */
export function maskKey(key: string): string {
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** What a push monitor's clock is read from. */
export type PushClock = {
  enabled: number;
  state: "ok" | "open";
  every_ms: number | null;
  grace_ms: number | null;
  /** The time its next result's due is counted from: its last result, or when it was made, resumed or its schedule changed. */
  due_from: number | null;
  created_at: number;
  /** A run's `/start`, until its result. */
  started_at: number | null;
};

/** When its next result is due, or null when it goes by its results alone. */
export function pushDueAt(m: PushClock): number | null {
  if (m.every_ms === null || m.every_ms <= 0) {
    return null;
  }
  return (m.due_from ?? m.created_at) + m.every_ms;
}

/** When it opens if nothing comes: its due time plus its grace. */
export function pushOpensAt(m: PushClock): number | null {
  const due = pushDueAt(m);
  return due === null ? null : due + (m.grace_ms ?? defaultGraceMs(m.every_ms!));
}

/** Past due with nothing in, and not yet open (18c, 18f). */
export function isLate(m: PushClock, nowMs: number): boolean {
  const due = pushDueAt(m);
  return m.enabled !== 0 && m.state !== "open" && due !== null && nowMs > due;
}

/** A run that has started and not yet said how it went. */
export function isRunning(m: PushClock): boolean {
  return m.started_at !== null && m.enabled !== 0;
}

/** "late 6m": how long past due. */
export function lateFor(m: PushClock, nowMs: number): string {
  const due = pushDueAt(m);
  return due === null ? "" : formatOpenFor(Math.max(0, nowMs - due));
}

/** Where a push monitor's results come in, for its row and the first-result box. */
export type CheckVia = "checks" | "ping" | "wrapper" | "probes";

/** "via toposcope.sh check", "via /ping", … */
export function viaLabel(via: CheckVia | string | null): string {
  switch (via) {
    case "wrapper":
      return "via toposcope.sh check";
    case "ping":
      return "via /ping";
    case "probes":
      return "via /v1/probes";
    case "checks":
      return "via /v1/checks";
    default:
      return "";
  }
}

