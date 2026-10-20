import type { Database } from "bun:sqlite";
import type { AlertRule } from "../control/alerts";
import {
  judgeRun,
  parseConditions,
  type ConditionLine,
  type HttpMethod,
  type HttpResult,
  type Verdict,
} from "../shared/http-check";
import type { LogEvent } from "../shared/log-event";
import type { MetricPoint } from "../shared/metric";
import { formatOpenFor, monitorQuery, remindEveryMs } from "../shared/monitor";
import type { WebhookOutcome } from "./delivery";
import type { HttpSettings } from "./http-store";
import { noteHttpRun } from "./http-store";
import type { HttpExchange, HttpRequestInput } from "./http-request";
import { monitorCalls, nextMove } from "./monitor";
import {
  beginStretch,
  noteReading,
  openStretch,
  recordCall,
  recordMonitorResult,
  recordResult,
  resolveStretch,
  type CallWhat,
  type MonitorStretch,
  type Reading,
} from "./monitor-store";
import {
  httpCallBody,
  httpFillValues,
  renderResolved,
  renderWebhook,
  type WebhookPayload,
} from "./payload";

/** The metric each run's time is also kept as, labelled by its monitor. */
export const monitorDurationMetric = "monitor_duration_ms";

export type HttpCheck = {
  url: string;
  method: HttpMethod;
  headers: ReadonlyArray<readonly [string, string]>;
  body: string | null;
  lines: readonly ConditionLine[];
};

export type HttpRun = { exchange: HttpExchange; verdict: Verdict; durationMs: number };

/** One request from this node and what its lines make of it: a monitor's run, or the editor's Send. */
export async function sendHttpCheck(
  check: HttpCheck,
  request: (input: HttpRequestInput) => Promise<HttpExchange>,
  clock: () => number = Date.now,
): Promise<HttpRun> {
  const exchange = await request({ url: check.url, method: check.method, headers: check.headers, body: check.body });
  const durationMs = Math.round(exchange.timings.total);
  const verdict = judgeRun(
    check.lines,
    exchange.ok
      ? {
          url: check.url,
          seen: {
            status: exchange.status,
            headers: exchange.headers,
            body: exchange.body,
            durationMs,
            https: check.url.startsWith("https:"),
            certValidTo: exchange.cert?.valid_to ?? null,
          },
        }
      : { error: exchange.error },
    clock(),
  );
  return { exchange, verdict, durationMs };
}

/** The run in words, as its row and its stretch say it: why it is not ok, or what came back. */
export function runSummary(run: HttpRun): string {
  if (run.verdict.why) {
    return run.verdict.why;
  }
  return run.exchange.ok ? `${run.exchange.status} in ${run.durationMs}ms` : "no response";
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

const levelOf: Record<HttpResult, LogEvent["level"]> = { ok: "info", warn: "warn", fail: "error" };

/**
 * Every run is a row (`monitor:<name> status:<status> source:http`) with `http.status`,
 * `duration_ms`, the line that decided it and why, so `monitor:api-health duration_ms:>300` is a
 * search. A run that got an answer also keeps its time as the metric `monitor_duration_ms`.
 */
export function runRow(
  name: string,
  check: Pick<HttpCheck, "url" | "method">,
  run: HttpRun,
  at: number,
): { row: LogEvent; metric: MetricPoint | null } {
  const result = run.verdict.result;
  const ts = new Date(at).toISOString();
  const attrs: Record<string, unknown> = {
    monitor: name,
    status: result,
    source: "http",
    method: check.method,
    url: check.url,
    duration_ms: run.durationMs,
  };
  if (run.exchange.ok) {
    attrs["http.status"] = run.exchange.status;
  }
  if (run.verdict.line) {
    attrs.line = run.verdict.line;
  }
  if (run.verdict.why) {
    attrs.error = run.verdict.why;
  }
  return {
    row: {
      ts,
      service: "toposcope",
      host: hostOf(check.url),
      level: levelOf[result],
      message: `${name} ${result} · ${runSummary(run)}`,
      attrs,
    },
    metric: run.exchange.ok
      ? { ts, name: monitorDurationMetric, value: run.durationMs, labels: { monitor: name, source: "http" } }
      : null,
  };
}

export type HttpMonitorDeps = {
  db: Database;
  request: (input: HttpRequestInput) => Promise<HttpExchange>;
  /** The row and the metric into ClickHouse. A monitor still opens and resolves when that fails. */
  write: (row: LogEvent, metric: MetricPoint | null) => Promise<void>;
  post: (url: string, payload: WebhookPayload) => Promise<WebhookOutcome>;
  publicUrl: () => string | null;
  recordWebhook: (id: string, attempt: WebhookOutcome & { at: number }, db: Database) => void;
  onSent?: () => void;
  clock?: () => number;
};

export function httpLines(conditions: string): ConditionLine[] {
  const parsed = parseConditions(conditions);
  // The stored lines were checked when saved.
  return "error" in parsed ? [] : parsed;
}

/**
 * One run of an HTTP(S) monitor (#178). A fail adds to its failures in a row and opens it once
 * there are `fail_after` of them; an ok resolves it; a warn shows and changes neither. Then its
 * calls, as any monitor's.
 */
export async function runHttpMonitor(
  rule: AlertRule,
  http: HttpSettings,
  at: number,
  deps: HttpMonitorDeps,
): Promise<HttpRun> {
  const db = deps.db;
  const check: HttpCheck = {
    url: http.url,
    method: http.method,
    headers: http.headers,
    body: http.body,
    lines: httpLines(http.conditions),
  };
  const run = await sendHttpCheck(check, deps.request, deps.clock);
  const { row, metric } = runRow(rule.name, check, run, at);
  try {
    await deps.write(row, metric);
  } catch (err) {
    console.error(`monitor ${rule.name}: its row was not written`, err);
  }

  const result = run.verdict.result;
  const failsInRow = result === "fail" ? http.fails_in_row + 1 : 0;
  noteHttpRun(
    rule.id,
    failsInRow,
    {
      at,
      result,
      status: run.exchange.ok ? run.exchange.status : null,
      duration_ms: run.durationMs,
      line: run.verdict.line,
      why: run.verdict.why,
      cert_valid_to: run.exchange.cert?.valid_to ?? null,
    },
    db,
  );
  recordResult(rule.id, result, run.durationMs, at, db);
  // Watch's tick for it: the worst run of its minute.
  recordMonitorResult(
    {
      monitor_id: rule.id,
      at,
      result,
      exit_code: null,
      duration_ms: run.durationMs,
      value: null,
      unit: null,
      message: runSummary(run),
      host: hostOf(http.url),
      via: "http",
    },
    db,
  );
  const reading: Reading = {
    value: run.durationMs,
    count: run.exchange.ok ? run.exchange.status : 0,
    message: runSummary(run),
  };
  const open = openStretch(rule.id, db);
  switch (nextMove(open ? "open" : "ok", result)) {
    case "open":
      if (failsInRow >= http.fail_after) {
        beginStretch(rule.id, at, reading, db);
      }
      break;
    case "still-open":
      noteReading(open!.id, at, reading, db);
      break;
    case "resolve":
      resolveStretch(rule.id, open!.id, at, reading, db);
      break;
    default:
      break;
  }

  if (rule.webhook_url) {
    await monitorCalls(rule, at, remindEveryMs(rule.remind_every, http.every_ms), db, (what, stretch) =>
      sendHttpCall(rule, http, { what, stretch, run, at }, deps),
    );
  }
  return run;
}

/** One call for a stretch, as `sendSearchCall` makes one for a search. */
async function sendHttpCall(
  rule: AlertRule,
  http: HttpSettings,
  input: { what: Exclude<CallWhat, "sent">; stretch: MonitorStretch; run: HttpRun; at: number },
  deps: HttpMonitorDeps,
): Promise<WebhookOutcome> {
  const { what, stretch, run, at } = input;
  const iso = (ms: number) => new Date(ms).toISOString();
  // The open call says what opened it; a reminder or a resolved call says what it reads now.
  const status = what === "open" ? stretch.open_count || null : run.exchange.ok ? run.exchange.status : null;
  const durationMs = what === "open" ? (stretch.open_value ?? run.durationMs) : run.durationMs;
  const endMs = stretch.resolved_at ?? at;
  const base = deps.publicUrl();
  // Its rows from a while before it opened to now.
  const fromMs = stretch.opened_at - Math.max(15 * 60_000, 3 * http.every_ms);
  const link = base
    ? `${base}/?${new URLSearchParams({ q: monitorQuery(rule.name), range: "custom", from: iso(fromMs), to: iso(at) }).toString()}`
    : null;
  const facts = {
    alert: { id: rule.id, name: rule.name },
    method: http.method,
    url: http.url,
    status,
    durationMs,
    message: stretch.open_message,
    firedAt: iso(at),
    link,
    call: {
      state: what,
      openedAt: iso(stretch.opened_at),
      resolvedAt: stretch.resolved_at !== null ? iso(stretch.resolved_at) : null,
      duration: formatOpenFor(endMs - stretch.opened_at),
    },
  };
  const defaultBody = httpCallBody(rule.webhook_url!, facts);
  const values = httpFillValues(facts);
  const payload =
    what === "resolved" ? renderResolved(rule, defaultBody, values)! : renderWebhook(rule, defaultBody, values);
  const outcome = await deps.post(rule.webhook_url!, payload);
  deps.recordWebhook(rule.id, { at, ...outcome }, deps.db);
  recordCall(
    { monitor_id: rule.id, stretch_id: stretch.id, at, what, status: outcome.status, ok: outcome.ok, error: outcome.error },
    deps.db,
  );
  if (outcome.ok) {
    deps.onSent?.();
  }
  return outcome;
}
