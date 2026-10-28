import { timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { applyPushResult, noteStart, type PushResult } from "../alerts/push";
import { getAlert, monitorsNamed, type AlertRule } from "../control/alerts";
import { getDb } from "../control/index";
import {
  insertPushMonitor,
  pushCapProblem,
  pushFieldsOfResult,
  pushKeys,
} from "../control/push-monitors";
import { incMetric } from "../metrics";
import type { LogEvent } from "../shared/log-event";
import {
  exitCodeOfStatus,
  levelOfStatus,
  maxCheckBatch,
  maxCheckMessage,
  maxCheckUnit,
  maxPingBody,
  parseCheckStatus,
  parseEvery,
  parseGrace,
  parsePushName,
  pingEveryMs,
  pingStatusOfExitCode,
  type CheckVia,
} from "../shared/push";
import { InsertBackpressureError } from "./backpressure";
import { insertErrorMessage, insertEvents, MAX_BODY_BYTES } from "./index";
import { insertMetricPoints } from "./metrics";

/** A pushed value is this metric, labelled with its monitor (#177). */
export const monitorValueMetric = "monitor_value";

export class InvalidCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCheckError";
  }
}

function optionalText(raw: unknown, field: string, max: number): string {
  if (raw === undefined || raw === null) {
    return "";
  }
  if (typeof raw !== "string") {
    throw new InvalidCheckError(`${field} must be a string`);
  }
  const text = raw.trim();
  if (text.length > max) {
    throw new InvalidCheckError(`${field} is longer than ${max} characters`);
  }
  return text;
}

/**
 * One result of `POST /v1/checks`: `{ monitor, status, message?, value?, unit?, every?, grace?,
 * host?, service?, ts?, exit_code?, duration_ms? }`. `status` is `ok`, `warn` or `fail`, or
 * `0`–`3` (Nagios's ok, warning, critical, unknown).
 */
export function parseCheck(raw: unknown, nowMs: number, via: CheckVia): PushResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new InvalidCheckError("Expected a result object");
  }
  const rec = raw as Record<string, unknown>;
  const monitor = parsePushName(rec.monitor);
  if (typeof monitor !== "string") {
    throw new InvalidCheckError(monitor.error);
  }
  const status = parseCheckStatus(rec.status);
  if (!status) {
    throw new InvalidCheckError("status must be ok, warn or fail, or 0–3");
  }
  let message = "";
  if (rec.message !== undefined && rec.message !== null) {
    if (typeof rec.message !== "string") {
      throw new InvalidCheckError("message must be a string");
    }
    message = rec.message.trim().slice(0, maxCheckMessage);
  }
  let value: number | null = null;
  if (rec.value !== undefined && rec.value !== null) {
    if (typeof rec.value !== "number" || !Number.isFinite(rec.value)) {
      throw new InvalidCheckError("value must be a number");
    }
    value = rec.value;
  }
  const unit = optionalText(rec.unit, "unit", maxCheckUnit);
  const result: PushResult = {
    monitor,
    status,
    message,
    value,
    unit: unit || null,
    host: optionalText(rec.host, "host", 256),
    service: optionalText(rec.service, "service", 128) || "monitor",
    ts: new Date(nowMs).toISOString(),
    exit_code: exitCodeOfStatus(rec.status),
    duration_ms: null,
    via,
    from: "",
  };
  if (rec.every !== undefined && rec.every !== null && rec.every !== "") {
    const every = parseEvery(rec.every);
    if (every === null) {
      throw new InvalidCheckError("every must be a span from 30s to 365d, like 5m, 1h or 1d");
    }
    result.every_ms = every;
  }
  if (rec.grace !== undefined && rec.grace !== null && rec.grace !== "") {
    const grace = parseGrace(rec.grace);
    if (grace === null) {
      throw new InvalidCheckError("grace must be a span up to 365d, like 2m or 1h, or 0");
    }
    result.grace_ms = grace;
  }
  if (rec.ts !== undefined && rec.ts !== null && rec.ts !== "") {
    const ts = typeof rec.ts === "string" ? Date.parse(rec.ts) : NaN;
    if (!Number.isFinite(ts)) {
      throw new InvalidCheckError("ts must be an ISO timestamp");
    }
    result.ts = new Date(ts).toISOString();
  }
  if (rec.exit_code !== undefined && rec.exit_code !== null) {
    if (typeof rec.exit_code !== "number" || !Number.isInteger(rec.exit_code) || rec.exit_code < 0 || rec.exit_code > 255) {
      throw new InvalidCheckError("exit_code must be a whole number from 0 to 255");
    }
    result.exit_code = rec.exit_code;
  }
  if (rec.duration_ms !== undefined && rec.duration_ms !== null) {
    if (typeof rec.duration_ms !== "number" || !Number.isFinite(rec.duration_ms) || rec.duration_ms < 0) {
      throw new InvalidCheckError("duration_ms must be a number, at least 0");
    }
    result.duration_ms = Math.round(rec.duration_ms);
  }
  result.from = result.host;
  return result;
}

/** A result's log row: `monitor:<name> status:<status> source:push`, with its run and exit code. */
export function resultRow(result: PushResult): LogEvent {
  const attrs: Record<string, unknown> = { monitor: result.monitor, status: result.status, source: "push" };
  if (result.exit_code !== null) {
    attrs.exit_code = result.exit_code;
  }
  if (result.duration_ms !== null) {
    attrs.duration_ms = result.duration_ms;
  }
  return {
    ts: result.ts,
    service: result.service,
    host: result.host,
    level: levelOfStatus(result.status),
    message: result.message,
    attrs,
  };
}

/** A run's `/start` is a row too, so its hunt shows when it began (18i). */
export function startRow(name: string, ts: string, message: string): LogEvent {
  return {
    ts,
    service: "monitor",
    host: "",
    level: "info",
    message,
    attrs: { monitor: name, signal: "start", source: "push" },
  };
}

export type ApplyOutcome =
  | { ok: true; ingested: number; created: string[] }
  | { ok: false; status: 400 | 429 | 503; error: string };

/**
 * Results in: each names its monitor, and a name not seen before creates a push monitor (up to
 * 500). Rows and values go to ClickHouse first, so a sender told to retry has changed nothing;
 * then each result moves its monitor, in the order sent.
 */
export async function applyResults(results: PushResult[], nowMs: number): Promise<ApplyOutcome> {
  const db = getDb();
  const names = [...new Set(results.map((r) => r.monitor))];
  const named = monitorsNamed(names, db);
  const known = new Map<string, AlertRule>();
  for (const rule of named) {
    if (rule.source === "push" && !known.has(rule.name)) {
      known.set(rule.name, rule);
    }
  }
  const taken = named.find((rule) => rule.source !== "push" && !known.has(rule.name));
  if (taken) {
    return {
      ok: false,
      status: 400,
      error: `${taken.name} is a ${taken.source} monitor; results go to push monitors`,
    };
  }
  const fresh = names.filter((name) => !known.has(name));
  const cap = fresh.length > 0 ? pushCapProblem(fresh.length, db) : null;
  if (cap) {
    return { ok: false, status: 400, error: cap };
  }
  // A run measured from its monitor's `/start`, when its sender did not say how long it took.
  for (const result of results) {
    const started = known.get(result.monitor)?.started_at ?? null;
    if (result.duration_ms === null && started !== null && nowMs >= started) {
      result.duration_ms = nowMs - started;
    }
  }
  const points = results
    .filter((r) => r.value !== null)
    .map((r) => ({ ts: r.ts, name: monitorValueMetric, value: r.value!, labels: { monitor: r.monitor } }));
  try {
    const ingested = await insertEvents(results.map(resultRow));
    incMetric("ingest_events", ingested);
    if (points.length > 0) {
      incMetric("ingest_metrics", await insertMetricPoints(points));
    }
  } catch (err) {
    if (err instanceof InsertBackpressureError) {
      return { ok: false, status: 429, error: "ClickHouse is busy" };
    }
    return { ok: false, status: 503, error: insertErrorMessage(err) };
  }
  const created: string[] = [];
  for (const result of results) {
    // Looked up again: a request that ran beside this one may have made it meanwhile.
    let rule = monitorsNamed([result.monitor], db).find((r) => r.source === "push") ?? null;
    if (!rule) {
      const made = insertPushMonitor(
        pushFieldsOfResult(result.monitor, result.every_ms ?? null, result.grace_ms ?? null),
        nowMs,
        db,
      );
      if ("error" in made) {
        continue;
      }
      // A monitor made by its first result is about that result's service (#335).
      db.query("UPDATE alert_rules SET service = ? WHERE id = ?").run(result.service || "monitor", made.id);
      rule = { ...made, service: result.service || "monitor" };
      created.push(rule.name);
    }
    await applyPushResult(rule, result, nowMs, db);
  }
  return { ok: true, ingested: results.length, created };
}

function parseRows(text: string, contentType: string): unknown[] {
  const ndjson = contentType.includes("application/x-ndjson") || contentType.includes("application/ndjson");
  if (!ndjson) {
    try {
      const json: unknown = JSON.parse(text);
      return Array.isArray(json) ? json : [json];
    } catch {
      // Lines, below.
    }
  }
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

/** `toposcope.sh check` says who it is, so its first result reads "via toposcope.sh check" (18s). */
function viaOf(c: Context): CheckVia {
  return (c.req.header("user-agent") ?? "").startsWith("toposcope.sh/") ? "wrapper" : "checks";
}

/** `POST /v1/checks` (#177): one result or up to 500, with the ingest token. */
export async function ingestChecksRoute(c: Context): Promise<Response> {
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength > MAX_BODY_BYTES) {
    return c.json({ error: `Body too large (max ${MAX_BODY_BYTES} bytes)` }, 413);
  }
  const text = new TextDecoder().decode(buf).trim();
  if (text.length === 0) {
    return c.json({ error: "Empty body" }, 400);
  }
  let rows: unknown[];
  try {
    rows = parseRows(text, c.req.header("content-type") ?? "");
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (rows.length === 0) {
    return c.json({ error: "Expected a result or a non-empty array" }, 400);
  }
  if (rows.length > maxCheckBatch) {
    return c.json({ error: `Batch too large (max ${maxCheckBatch})` }, 400);
  }
  const now = Date.now();
  const via = viaOf(c);
  const results: PushResult[] = [];
  for (const [i, row] of rows.entries()) {
    try {
      results.push(parseCheck(row, now, via));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid result";
      return c.json({ error: rows.length > 1 ? `result ${i}: ${message}` : message }, 400);
    }
  }
  const out = await applyResults(results, now);
  if (!out.ok) {
    return c.json({ error: out.error }, out.status, out.status === 429 ? { "retry-after": "1" } : undefined);
  }
  return c.json({ ingested: out.ingested, created: out.created });
}

/** The last stored ping of each key, its start and its result apart: at most one of each a second. */
const lastPing = new Map<string, { start: number; result: number }>();

/**
 * Which push monitor holds this key. Every key is compared, all the way, whatever matched, so a
 * wrong key takes as long as a right one.
 */
export function monitorOfKey(key: string): string | null {
  const want = Buffer.alloc(36);
  want.write(key.slice(0, 36), "utf8");
  const shaped = key.length === 36;
  let found: string | null = null;
  for (const row of pushKeys()) {
    const have = Buffer.alloc(36);
    have.write(row.key, "utf8");
    if (timingSafeEqual(want, have) && shaped) {
      found = row.id;
    }
  }
  return found;
}

type PingSignal = { kind: "start" } | { kind: "result"; status: "ok" | "fail"; exit: number | null };

/** `""` ok, `start`, `fail`, or an exit code 0–255 (0 ok, else a fail), as Healthchecks reads them. */
export function parsePingSignal(raw: string): PingSignal | null {
  if (raw === "") {
    return { kind: "result", status: "ok", exit: null };
  }
  if (raw === "start") {
    return { kind: "start" };
  }
  if (raw === "fail") {
    return { kind: "result", status: "fail", exit: null };
  }
  if (/^\d{1,3}$/.test(raw) && Number(raw) <= 255) {
    const exit = Number(raw);
    return { kind: "result", status: pingStatusOfExitCode(exit) as "ok" | "fail", exit };
  }
  return null;
}

/** A POST body up to 10 KB, as text; the rest is not read. */
async function readCapped(req: Request): Promise<string> {
  if (req.method !== "POST" || !req.body) {
    return "";
  }
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < maxPingBody) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  const all = new Uint8Array(Math.min(size, maxPingBody));
  let at = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, all.byteLength - at);
    all.set(part, at);
    at += part.byteLength;
    if (at >= all.byteLength) {
      break;
    }
  }
  return new TextDecoder().decode(all).trim();
}

/** The address a ping came from, for Watch: the proxy's word for it, else the socket's. */
function remoteAddress(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) {
    return forwarded.slice(0, 64);
  }
  const server = c.env as { requestIP?: (req: Request) => { address: string } | null } | undefined;
  return server?.requestIP?.(c.req.raw)?.address ?? "";
}

const notFound = () => new Response("not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });

/**
 * `GET|POST /ping/<key>[/start|/fail|/<exit code>]` (#177): a cron line's result with no token;
 * the key in the path is the credential. A POST body (up to 10 KB) is the message. An unknown
 * key gets 404 and writes nothing; a second ping of the same kind within a second gets 429.
 */
export async function pingRoute(c: Context): Promise<Response> {
  const key = c.req.param("key") ?? "";
  const signal = parsePingSignal(c.req.param("signal") ?? "");
  const id = monitorOfKey(key);
  if (!id || !signal) {
    return notFound();
  }
  const rule = getAlert(id);
  if (!rule) {
    return notFound();
  }
  const now = Date.now();
  const last = lastPing.get(key) ?? { start: 0, result: 0 };
  const kind = signal.kind;
  if (now - last[kind] < pingEveryMs) {
    return new Response("too many pings: at most one a second\n", {
      status: 429,
      headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "1" },
    });
  }
  lastPing.set(key, { ...last, [kind]: now });
  const message = await readCapped(c.req.raw);
  const ts = new Date(now).toISOString();
  try {
    if (signal.kind === "start") {
      incMetric("ingest_events", await insertEvents([startRow(rule.name, ts, message)]));
      noteStart(rule.id, now, getDb());
    } else {
      const out = await applyResults(
        [
          {
            monitor: rule.name,
            status: signal.status,
            message,
            value: null,
            unit: null,
            host: "",
            service: "monitor",
            ts,
            exit_code: signal.exit,
            duration_ms: null,
            via: "ping",
            from: remoteAddress(c),
          },
        ],
        now,
      );
      if (!out.ok) {
        lastPing.set(key, last);
        return new Response(`${out.error}\n`, { status: out.status, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
    }
  } catch (err) {
    lastPing.set(key, last);
    if (err instanceof InsertBackpressureError) {
      return new Response("busy\n", { status: 429, headers: { "retry-after": "1" } });
    }
    return new Response(`${insertErrorMessage(err)}\n`, { status: 503 });
  }
  return new Response("OK\n", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
}
