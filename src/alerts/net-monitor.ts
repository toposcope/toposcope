import type { AlertRule } from "../control/alerts";
import { parseConditions, type ConditionLine, type HttpResult, type Verdict } from "../shared/http-check";
import type { LogEvent } from "../shared/log-event";
import type { MetricPoint } from "../shared/metric";
import { formatOpenFor } from "../shared/monitor";
import { judgeNetRun, parseNetTarget, type NetSource, type Starttls } from "../shared/net-check";
import { monitorQuery } from "../shared/push";
import { monitorDurationMetric, settleNodeRun, type HttpMonitorDeps } from "./http-monitor";
import type { NetExchange, NetRequestInput } from "./net-request";
import { noteNetRun, type NetSettings } from "./net-store";
import type { CallDeps } from "./monitor";
import type { CallWhat, MonitorStretch } from "./monitor-store";
import { netCallBody, netFillValues, renderResolved, renderWebhook, type WebhookPayload } from "./payload";

export type NetCheck = {
  source: NetSource;
  /** host:port. */
  target: string;
  starttls: Starttls | null;
  lines: readonly ConditionLine[];
};

export type NetRun = { exchange: NetExchange; verdict: Verdict; durationMs: number };

/** Its runs go as an HTTP(S) monitor's do, with a connector of their own. */
export type NetMonitorDeps = Omit<HttpMonitorDeps, "request"> & {
  connect: (input: NetRequestInput) => Promise<NetExchange>;
};

export function netLines(conditions: string, source: NetSource): ConditionLine[] {
  const parsed = parseConditions(conditions, source);
  // The stored lines were checked when saved.
  return "error" in parsed ? [] : parsed;
}

/** One run from this node and what its lines make of it: a monitor's run, or the editor's Send. */
export async function sendNetCheck(
  check: NetCheck,
  connect: (input: NetRequestInput) => Promise<NetExchange>,
  clock: () => number = Date.now,
): Promise<NetRun> {
  const target = parseNetTarget(check.target);
  if ("error" in target) {
    // The stored target was checked when saved.
    throw new Error(target.error);
  }
  const exchange = await connect({
    host: target.host,
    port: target.port,
    tls: check.source === "cert",
    starttls: check.source === "cert" ? check.starttls : null,
  });
  const durationMs = Math.round(exchange.timings.total);
  const verdict = judgeNetRun(
    check.source,
    check.lines,
    exchange.ok ? { host: target.host, seen: { durationMs, cert: exchange.cert } } : { error: exchange.error },
    clock(),
  );
  return { exchange, verdict, durationMs };
}

/** The run in words, as its row and its stretch say it: why it is not ok, or how it went. */
export function netRunSummary(source: NetSource, run: NetRun, nowMs: number): string {
  if (run.verdict.why) {
    return run.verdict.why;
  }
  if (source === "cert" && run.exchange.ok && run.exchange.cert) {
    const left = Math.floor((Date.parse(run.exchange.cert.valid_to) - nowMs) / (24 * 60 * 60_000));
    return `certificate for ${run.exchange.cert.subject || run.exchange.cert.names[0] || "no name"}, ${left} days left`;
  }
  return `connected in ${run.durationMs}ms`;
}

const levelOf: Record<HttpResult, LogEvent["level"]> = { ok: "info", warn: "warn", fail: "error" };

function hostOf(target: string): string {
  const t = parseNetTarget(target);
  return "error" in t ? "" : t.host;
}

/**
 * Every run is a row (`monitor:<name> status:<status> source:tcp|cert`) with `target`,
 * `duration_ms`, the line that decided it and why, and for a certificate monitor what the
 * certificate said. A run that got as far as it goes also keeps its time as `monitor_duration_ms`.
 */
export function netRunRow(
  name: string,
  check: Pick<NetCheck, "source" | "target" | "starttls">,
  run: NetRun,
  at: number,
): { row: LogEvent; metric: MetricPoint | null } {
  const result = run.verdict.result;
  const ts = new Date(at).toISOString();
  const attrs: Record<string, unknown> = {
    monitor: name,
    status: result,
    source: check.source,
    target: check.target,
    duration_ms: run.durationMs,
  };
  if (check.starttls) {
    attrs.starttls = check.starttls;
  }
  const cert = run.exchange.cert;
  if (cert) {
    attrs["cert.subject"] = cert.subject;
    attrs["cert.valid_to"] = cert.valid_to;
    attrs["cert.days_left"] = Math.floor((Date.parse(cert.valid_to) - at) / (24 * 60 * 60_000));
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
      host: hostOf(check.target),
      level: levelOf[result],
      message: `${name} ${result} · ${netRunSummary(check.source, run, at)}`,
      attrs,
    },
    // A run that got as far as it goes keeps its time, as an HTTP(S) run with an answer does.
    metric: run.exchange.ok
      ? { ts, name: monitorDurationMetric, value: run.durationMs, labels: { monitor: name, source: check.source } }
      : null,
  };
}

/**
 * One run of a TCP or certificate monitor (#180), recorded, opened and resolved as an HTTP(S)
 * run is: a fail adds to its failures in a row and opens it at `fail_after`; an ok resolves it;
 * a warn shows and changes neither. Then its calls.
 */
export async function runNetMonitor(rule: AlertRule, net: NetSettings, at: number, deps: NetMonitorDeps): Promise<NetRun> {
  const source: NetSource = rule.source === "cert" ? "cert" : "tcp";
  const check: NetCheck = { source, target: net.target, starttls: net.starttls, lines: netLines(net.conditions, source) };
  const run = await sendNetCheck(check, deps.connect, deps.clock);
  const { row, metric } = netRunRow(rule.name, check, run, at);
  try {
    await deps.write(row, metric);
  } catch (err) {
    console.error(`monitor ${rule.name}: its row was not written`, err);
  }
  const result = run.verdict.result;
  const failsInRow = result === "fail" ? net.fails_in_row + 1 : 0;
  const x = run.exchange;
  noteNetRun(
    rule.id,
    failsInRow,
    {
      at,
      result,
      connected: x.ok || x.address !== null,
      duration_ms: run.durationMs,
      line: run.verdict.line,
      why: run.verdict.why,
      cert_valid_to: x.cert?.valid_to ?? null,
      cert_subject: x.cert?.subject ?? null,
    },
    deps.db,
  );
  const message = netRunSummary(source, run, at);
  await settleNodeRun(
    rule,
    {
      result,
      durationMs: run.durationMs,
      message,
      host: hostOf(net.target),
      via: source,
      reading: { value: run.durationMs, count: x.ok ? 1 : 0, message },
      failsInRow,
      failAfter: net.fail_after,
      everyMs: net.every_ms,
      payload: (what, stretch, url) => netCallPayload(rule, net, source, { what, stretch, run, at, url }, deps),
    },
    at,
    deps,
  );
  return run;
}

/** One call for a stretch, as it goes on the wire. */
function netCallPayload(
  rule: AlertRule,
  net: NetSettings,
  source: NetSource,
  input: { what: Exclude<CallWhat, "sent">; stretch: MonitorStretch; run: NetRun; at: number; url: string },
  deps: Pick<CallDeps, "publicUrl">,
): WebhookPayload {
  const { what, stretch, run, at } = input;
  const iso = (ms: number) => new Date(ms).toISOString();
  const endMs = stretch.resolved_at ?? at;
  const base = deps.publicUrl();
  // Its rows from a while before it opened to now.
  const fromMs = stretch.opened_at - Math.max(15 * 60_000, 3 * net.every_ms);
  const link = base
    ? `${base}/?${new URLSearchParams({ q: monitorQuery(rule.name), range: "custom", from: iso(fromMs), to: iso(at) }).toString()}`
    : null;
  const facts = {
    alert: { id: rule.id, name: rule.name, source },
    target: net.target,
    starttls: net.starttls,
    // The open call says what opened it; a reminder or a resolved call says what it reads now.
    durationMs: what === "open" ? (stretch.open_value ?? run.durationMs) : run.durationMs,
    message: stretch.open_message,
    certValidTo: run.exchange.cert?.valid_to ?? null,
    firedAt: iso(at),
    link,
    call: {
      state: what,
      openedAt: iso(stretch.opened_at),
      resolvedAt: stretch.resolved_at !== null ? iso(stretch.resolved_at) : null,
      duration: formatOpenFor(endMs - stretch.opened_at),
    },
  };
  const defaultBody = netCallBody(input.url, facts);
  const values = netFillValues(facts);
  return what === "resolved" ? renderResolved(rule, defaultBody, values)! : renderWebhook(rule, defaultBody, values);
}
