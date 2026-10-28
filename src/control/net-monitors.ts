import { stampCreated, stampUpdated } from "./actors";
import type { Context } from "hono";
import { closeByEdit } from "../alerts/monitor-store";
import { sendNetCheck } from "../alerts/net-monitor";
import { runNetRequest } from "../alerts/net-request";
import {
  forgetNet,
  getNet,
  insertNet,
  updateNet,
  type NetLastRun,
  type NetSettings,
  type NetWrite,
} from "../alerts/net-store";
import type { AlertBodyKind } from "../shared/alert-body";
import {
  defaultFailAfter,
  defaultHttpEvery,
  formatConditions,
  formatHttpEvery,
  maxFailAfter,
  parseConditions,
  parseHttpEvery,
  type ConditionLine,
} from "../shared/http-check";
import type { RemindId } from "../shared/monitor";
import {
  formatNetTarget,
  isNetSource,
  parseNetTarget,
  parseStarttls,
  type NetSource,
  type Starttls,
} from "../shared/net-check";
import { monitorQuery } from "../shared/push";
import { getAlert, parseWebhook, readBody, readRemind, type AlertRule } from "./alerts";
import { getDb } from "./index";
import type { MonitorPlace } from "./monitor-place";

/** A TCP or certificate monitor as the API shows it (#180). */
export type NetView = {
  target: string;
  starttls: Starttls | null;
  every: string;
  every_ms: number;
  conditions: string;
  fail_after: number;
  fails_in_row: number;
  next_run_at: number | null;
  last_run: NetLastRun | null;
};

export function netView(net: NetSettings): NetView {
  return {
    target: net.target,
    starttls: net.starttls,
    every: formatHttpEvery(net.every_ms),
    every_ms: net.every_ms,
    conditions: net.conditions,
    fail_after: net.fail_after,
    fails_in_row: net.fails_in_row,
    next_run_at: net.next_run_at,
    last_run: net.last_run,
  };
}

export type NetFields = {
  name: string;
  source: NetSource;
  write: NetWrite;
  /** Null: the default webhook from Settings, if one is set; with neither it calls nobody. */
  webhook_url: string | null;
  body_kind: AlertBodyKind;
  body_template: string | null;
  resolved_body: string | null;
  remind_every: RemindId;
};

type FieldsError = { error: string; status: 400 | 404 };

type Existing = { rule: AlertRule; net: NetSettings } | null;

/** Where it connects and its lines, as a create, an update or the editor's Send gives them. */
export function readNetCheck(
  rec: Record<string, unknown>,
  source: NetSource,
  stored: Pick<NetSettings, "target" | "starttls" | "conditions"> | null,
): { target: string; starttls: Starttls | null; lines: ConditionLine[]; conditions: string } | { error: string } {
  const raw = typeof rec.target === "string" ? rec.target : (stored?.target ?? "");
  const target = parseNetTarget(raw);
  if ("error" in target) {
    return target;
  }
  let starttls: Starttls | null = null;
  if (source === "cert") {
    const read = rec.starttls === undefined ? (stored?.starttls ?? null) : parseStarttls(rec.starttls);
    if (read === undefined) {
      return { error: "starttls must be smtp, imap or pop3, or null for TLS from the first byte" };
    }
    starttls = read;
  } else if (rec.starttls !== undefined && rec.starttls !== null) {
    return { error: "starttls is for a certificate monitor; a TCP monitor only connects" };
  }
  const text = rec.conditions === undefined ? (stored?.conditions ?? "") : rec.conditions;
  const joined = Array.isArray(text) ? text.map((l) => String(l)).join("\n") : typeof text === "string" ? text : null;
  if (joined === null) {
    return { error: "conditions must be lines of text" };
  }
  const parsed = parseConditions(joined, source);
  if ("error" in parsed) {
    return { error: `conditions ${parsed.error}` };
  }
  return { target: formatNetTarget(target), starttls, lines: parsed, conditions: formatConditions(parsed) };
}

/**
 * A TCP or certificate monitor's fields. With `existing` (an update), a field left out keeps its
 * value; without it (a create, or a replace by name), it takes its default.
 */
export function readNetFields(rec: Record<string, unknown>, source: NetSource, existing: Existing): NetFields | FieldsError {
  const nameRaw = typeof rec.name === "string" ? rec.name.trim() : "";
  const name = nameRaw.length > 0 ? nameRaw : (existing?.rule.name ?? "");
  if (name.length === 0) {
    return { error: "name is required", status: 400 };
  }
  const check = readNetCheck(rec, source, existing?.net ?? null);
  if ("error" in check) {
    return { error: check.error, status: 400 };
  }
  const everyMs =
    rec.every === undefined ? (existing?.net.every_ms ?? parseHttpEvery(defaultHttpEvery)!) : parseHttpEvery(rec.every);
  if (everyMs === null) {
    return { error: "every must be 30s … 1h: 30s, 1m, 5m, 15m, 30m or 1h", status: 400 };
  }
  const failAfter = rec.fail_after === undefined ? (existing?.net.fail_after ?? defaultFailAfter) : rec.fail_after;
  if (typeof failAfter !== "number" || !Number.isInteger(failAfter) || failAfter < 1 || failAfter > maxFailAfter) {
    return { error: `fail_after must be a whole number of runs, 1 to ${maxFailAfter}`, status: 400 };
  }
  // Its own webhook, or null for the default in Settings (#177), as an HTTP(S) monitor reads it.
  let webhook: string | null = existing?.rule.webhook_url ?? null;
  if (rec.webhook_url !== undefined || !existing) {
    if (rec.webhook_url === undefined || rec.webhook_url === null || rec.webhook_url === "") {
      webhook = null;
    } else {
      const parsed = parseWebhook(rec.webhook_url);
      if (typeof parsed !== "string") {
        return { error: "webhook_url must be http(s), or null for the default", status: 400 };
      }
      webhook = parsed;
    }
  }
  const body = readBody(rec, "net", existing?.rule ?? null);
  if ("error" in body) {
    return { error: body.error, status: 400 };
  }
  const remind = readRemind(rec, existing?.rule ?? null);
  if (typeof remind !== "string") {
    return { error: remind.error, status: 400 };
  }
  if (remind === "window") {
    return { error: "remind_every must be off, 1h, 4h or 24h", status: 400 };
  }
  return {
    name,
    source,
    write: {
      target: check.target,
      starttls: check.starttls,
      every_ms: everyMs,
      conditions: check.conditions,
      fail_after: failAfter,
    },
    webhook_url: webhook,
    ...body,
    remind_every: remind,
  };
}

/** A new TCP or certificate monitor: ok, and its first run is due now. */
export function insertNetMonitor(fields: NetFields, place: MonitorPlace, now = Date.now()): AlertRule {
  const id = crypto.randomUUID();
  const db = getDb();
  db.transaction(() => {
    db.query(
      `INSERT INTO alert_rules
        (id, name, query, webhook_url, saved_search_id, threshold, enabled, last_fired_at, created_at, kind, body_kind, body_template,
         source, state, remind_every, resolved_body, service, host)
       VALUES (?, ?, ?, ?, NULL, 1, 1, NULL, ?, ?, ?, ?, ?, 'ok', ?, ?, ?, ?)`,
    ).run(
      id,
      fields.name,
      // Its own rows, as an HTTP(S) monitor's: a hunt on them draws its stretches.
      monitorQuery(fields.name),
      fields.webhook_url,
      now,
      fields.source,
      fields.body_kind,
      fields.body_template,
      fields.source,
      fields.remind_every,
      fields.resolved_body,
      place.service,
      place.host,
    );
    insertNet(id, fields.write, now, db);
  })();
  stampCreated("alert_rules", id);
  return getAlert(id)!;
}

/**
 * Write a TCP or certificate monitor's fields over what it was. When where it connects or its
 * lines change, an open stretch closes without a call, its failures in a row start over, and it
 * runs now.
 */
export function applyNetFields(existing: AlertRule, net: NetSettings, fields: NetFields, now = Date.now()): void {
  const db = getDb();
  const w = fields.write;
  const readsAnew = w.target !== net.target || w.starttls !== net.starttls || w.conditions !== net.conditions;
  const nextRunAt = readsAnew
    ? now
    : w.every_ms !== net.every_ms
      ? Math.max(now, (net.last_run?.at ?? now) + w.every_ms)
      : (net.next_run_at ?? now);
  db.transaction(() => {
    db.query(
      `UPDATE alert_rules SET name = ?, query = ?, webhook_url = ?, body_kind = ?, body_template = ?, remind_every = ?, resolved_body = ?
       WHERE id = ?`,
    ).run(
      fields.name,
      monitorQuery(fields.name),
      fields.webhook_url,
      fields.body_kind,
      fields.body_template,
      fields.remind_every,
      fields.resolved_body,
      existing.id,
    );
      stampUpdated("alert_rules", existing.id);
    updateNet(existing.id, w, { nextRunAt, restart: readsAnew }, db);
  })();
  if (readsAnew && existing.state === "open") {
    closeByEdit(existing.id, now);
  }
  if ((fields.webhook_url ?? "") !== (existing.webhook_url ?? "")) {
    db.query(
      `UPDATE alert_rules SET last_attempt_at = NULL, last_status = NULL, last_error = NULL, consecutive_failures = 0
       WHERE id = ?`,
    ).run(existing.id);
  }
}

export function existingNet(rule: AlertRule): Existing {
  const net = isNetSource(rule.source) ? getNet(rule.id) : null;
  return net ? { rule, net } : null;
}

export { forgetNet };

/**
 * The editor's Send for a TCP or certificate monitor (#180): one run from this node, and what
 * came back: whether it connected, where the time went, the certificate, and what each line
 * makes of it. Nothing is stored.
 */
export async function sendNetRoute(c: Context, rec: Record<string, unknown>, source: NetSource): Promise<Response> {
  const check = readNetCheck({ conditions: "", ...rec }, source, null);
  if ("error" in check) {
    return c.json({ error: check.error }, 400);
  }
  const at = Date.now();
  const run = await sendNetCheck({ source, ...check }, runNetRequest);
  const x = run.exchange;
  return c.json({
    at,
    source,
    target: check.target,
    starttls: check.starttls,
    connected: x.ok || x.address !== null,
    address: x.address,
    greeting: x.greeting,
    protocol: x.protocol,
    error: x.ok ? null : x.error,
    timings: x.timings,
    cert: x.cert,
    duration_ms: run.durationMs,
    verdict: {
      result: run.verdict.result,
      line: run.verdict.line,
      why: run.verdict.why,
      lines: check.lines.map((l, i) => ({ text: l.text, level: l.level, ...run.verdict.lines[i]! })),
    },
  });
}
