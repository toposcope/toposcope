import { recordPushResult } from "./monitor-results";
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
import { formatOpenFor } from "../shared/monitor";
import { monitorQuery } from "../shared/push";
import type { HttpSettings } from "./http-store";
import { noteHttpRun } from "./http-store";
import type { HttpExchange, HttpRequestInput } from "./http-request";
import { nextMove, passCalls, type CallDeps } from "./monitor";
import {
  beginStretch,
  noteReading,
  openStretch,
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
  sendsResolved,
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

/** Its calls go as any monitor's (`CallDeps`: its own webhook, else the default in Settings). */
export type HttpMonitorDeps = CallDeps & {
  request: (input: HttpRequestInput) => Promise<HttpExchange>;
  /** The row and the metric into ClickHouse. A monitor still opens and resolves when that fails. */
  write: (row: LogEvent, metric: MetricPoint | null) => Promise<void>;
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
  await settleNodeRun(
    rule,
    {
      result,
      durationMs: run.durationMs,
      message: runSummary(run),
      host: hostOf(http.url),
      via: "http",
      // The status is what opened it, for its open call.
      reading: { value: run.durationMs, count: run.exchange.ok ? run.exchange.status : 0, message: runSummary(run) },
      failsInRow,
      failAfter: http.fail_after,
      everyMs: http.every_ms,
      payload: (what, stretch, url) => httpCallPayload(rule, http, { what, stretch, run, at, url }, deps),
    },
    at,
    deps,
  );
  return run;
}

/** What a run from this node (HTTP(S), TCP or certificate) leaves its monitor with. */
export type NodeRunOutcome = {
  result: HttpResult;
  durationMs: number;
  message: string;
  host: string;
  via: "http" | "tcp" | "cert";
  reading: Reading;
  /** Failures in a row with this run counted. */
  failsInRow: number;
  failAfter: number;
  everyMs: number;
  payload: (what: Exclude<CallWhat, "sent">, stretch: MonitorStretch, url: string) => WebhookPayload;
};

/**
 * A run's result kept, and what it does to its monitor: a fail opens it at `failAfter` in a row,
 * an ok resolves it, a warn shows and changes neither. Then its calls, as any monitor's.
 */
export async function settleNodeRun(rule: AlertRule, o: NodeRunOutcome, at: number, deps: CallDeps): Promise<void> {
  const db = deps.db;
  recordResult(rule.id, o.result, o.durationMs, at, db);
  const open = openStretch(rule.id, db);
  switch (nextMove(open ? "open" : "ok", o.result)) {
    case "open":
      if (o.failsInRow >= o.failAfter) {
        beginStretch(rule.id, at, o.reading, db);
      }
      break;
    case "still-open":
      noteReading(open!.id, at, o.reading, db);
      break;
    case "resolve":
      resolveStretch(rule.id, open!.id, at, o.reading, db);
      break;
    default:
      break;
  }
  // Watch's tick for it (#177), in ClickHouse with a position (#324). After the monitor's own
  // state: a monitor still opens and calls while ClickHouse is down.
  await recordPushResult({
    monitor_id: rule.id,
    at,
    result: o.result,
    exit_code: null,
    duration_ms: o.durationMs,
    value: null,
    unit: null,
    message: o.message,
    // What is checked (#335): the monitor's own host, else the one its run reached.
    host: rule.host || o.host,
    via: o.via,
    service: rule.service ?? "",
  }).catch((err) => console.error("monitor result not kept", err));

  // Its state is kept whether or not anybody is called; with no webhook of its own and none in
  // Settings, its stretches say nobody was (`none`).
  await passCalls(rule, at, { windowMs: o.everyMs, sendsResolved: sendsResolved(rule), payload: o.payload }, deps);
}

/** One call for a stretch, as it goes on the wire. */
function httpCallPayload(
  rule: AlertRule,
  http: HttpSettings,
  input: { what: Exclude<CallWhat, "sent">; stretch: MonitorStretch; run: HttpRun; at: number; url: string },
  deps: Pick<CallDeps, "publicUrl">,
): WebhookPayload {
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
  const defaultBody = httpCallBody(input.url, facts);
  const values = httpFillValues(facts);
  return what === "resolved" ? renderResolved(rule, defaultBody, values)! : renderWebhook(rule, defaultBody, values);
}
