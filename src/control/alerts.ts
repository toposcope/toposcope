import type { Database } from "bun:sqlite";
import type { Context } from "hono";
import { nextDelivery, nextEvalAttempt } from "../alerts/delivery";
import { closeByEdit, forgetMonitor } from "../alerts/monitor-store";
import {
  parseSilenceFor,
  silencedUntilFrom,
} from "../alerts/payload";
import { parseThreshold } from "../alerts/threshold";
import { getSaved } from "./saved-searches";
import { boardWatchRefuse } from "../shared/boards";
import { getDb } from "./index";
import { publicUrl } from "../shared/public-url";
import {
  alertBodyKinds,
  alertBodyProblem,
  resolvedBodyProblem,
  type AlertBodyKind,
} from "../shared/alert-body";
import {
  defaultRemind,
  parseRemind,
  sourceOfKind,
  type MonitorResult,
  type MonitorSource,
  type MonitorState,
  type RemindId,
} from "../shared/monitor";

const RULE_COLS =
  "id, name, query, webhook_url, saved_search_id, threshold, enabled, last_fired_at, last_attempt_at, last_status, last_error, consecutive_failures, silenced_until, created_at, kind, last_mark, body_kind, body_template, source, state, remind_every, resolved_body, last_result, last_value, last_result_at";

/** `threshold`: the saved search's series ≥ N. `first_seen`: a fingerprint first seen after a deploy or flag mark. */
export const alertKinds = ["threshold", "first_seen"] as const;
export type AlertKind = (typeof alertKinds)[number];

/** The mark a first-seen alert last paged on, for the Alerts list. */
export type AlertLastMark = {
  id: string;
  kind: string;
  title: string;
  service: string;
  ts: string;
  /** Fingerprints sent in that call. */
  count: number;
  at: number;
};

export type AlertRule = {
  id: string;
  name: string;
  kind: AlertKind;
  last_mark: AlertLastMark | null;
  /** `default` sends today's body (Slack's for a Slack URL); `text` / `json` send `body_template` filled in. */
  body_kind: AlertBodyKind;
  body_template: string | null;
  query: string;
  webhook_url: string | null;
  saved_search_id: string | null;
  threshold: number;
  enabled: number;
  last_fired_at: number | null;
  last_attempt_at: number | null;
  last_status: string | null;
  last_error: string | null;
  consecutive_failures: number;
  silenced_until: number | null;
  created_at: number;
  /** As a monitor (#175): where its results come from, ok or open, and how often it reminds. */
  source: MonitorSource;
  state: MonitorState;
  remind_every: RemindId;
  /** A text or JSON body's resolved call; without one it sends no resolved call. */
  resolved_body: string | null;
  last_result: MonitorResult | null;
  last_value: number | null;
  last_result_at: number | null;
};

type RuleRow = Omit<AlertRule, "kind" | "last_mark" | "body_kind" | "source" | "state" | "remind_every" | "last_result"> & {
  kind: string | null;
  last_mark: string | null;
  body_kind: string | null;
  source: string | null;
  state: string | null;
  remind_every: string | null;
  last_result: string | null;
};

function parseBodyKind(value: unknown): AlertBodyKind | null {
  return typeof value === "string" && (alertBodyKinds as readonly string[]).includes(value)
    ? (value as AlertBodyKind)
    : null;
}

/** The body fields of a create or update, checked for the alert's kind. */
export function readBody(
  rec: Record<string, unknown>,
  kind: AlertKind,
  existing: { body_kind: AlertBodyKind; body_template: string | null; resolved_body?: string | null } | null,
):
  | { body_kind: AlertBodyKind; body_template: string | null; resolved_body: string | null }
  | { error: string } {
  const bodyKind =
    rec.body_kind === undefined ? (existing?.body_kind ?? "default") : parseBodyKind(rec.body_kind);
  if (!bodyKind) {
    return { error: "body_kind must be default, text or json" };
  }
  const template =
    rec.body_template === undefined
      ? (existing?.body_template ?? null)
      : typeof rec.body_template === "string"
        ? rec.body_template
        : null;
  const problem = alertBodyProblem(bodyKind, template ?? "", kind);
  if (problem) {
    return { error: problem };
  }
  const resolvedRaw =
    rec.resolved_body === undefined
      ? (existing?.resolved_body ?? null)
      : typeof rec.resolved_body === "string"
        ? rec.resolved_body
        : null;
  const resolved = resolvedRaw && resolvedRaw.trim() ? resolvedRaw : null;
  const resolvedProblem = resolvedBodyProblem(bodyKind, resolved ?? "", kind);
  if (resolvedProblem) {
    return { error: resolvedProblem };
  }
  // A default body keeps the templates, so switching back to Text or JSON finds them.
  return { body_kind: bodyKind, body_template: template, resolved_body: resolved };
}

/** `remind_every` of a create or update: off, window, 1h, 4h or 24h. */
export function readRemind(
  rec: Record<string, unknown>,
  existing: { remind_every: RemindId } | null,
): RemindId | { error: string } {
  if (rec.remind_every === undefined) {
    return existing?.remind_every ?? defaultRemind;
  }
  return parseRemind(rec.remind_every) ?? { error: "remind_every must be off, window, 1h, 4h or 24h" };
}

function parseLastMark(raw: string | null): AlertLastMark | null {
  if (!raw) {
    return null;
  }
  try {
    const value = JSON.parse(raw) as AlertLastMark;
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

export function parseAlertKind(value: unknown): AlertKind | null {
  return typeof value === "string" && (alertKinds as readonly string[]).includes(value)
    ? (value as AlertKind)
    : null;
}

function mapRule(row: RuleRow): AlertRule {
  const kind = parseAlertKind(row.kind) ?? "threshold";
  return {
    ...row,
    kind,
    last_mark: parseLastMark(row.last_mark),
    body_kind: parseBodyKind(row.body_kind) ?? "default",
    body_template: row.body_template ?? null,
    threshold: Number(row.threshold),
    consecutive_failures: row.consecutive_failures ?? 0,
    silenced_until: row.silenced_until ?? null,
    source: sourceOfKind(kind),
    state: row.state === "open" ? "open" : "ok",
    remind_every: parseRemind(row.remind_every) ?? "window",
    resolved_body: row.resolved_body ?? null,
    last_result:
      row.last_result === "ok" || row.last_result === "warn" || row.last_result === "fail"
        ? row.last_result
        : null,
    last_value: row.last_value ?? null,
    last_result_at: row.last_result_at ?? null,
  };
}

/** A first-seen alert's threshold is a count of events: a whole number, at least 1. */
export function kindThreshold(kind: AlertKind, threshold: number): number | { error: string } {
  if (kind === "first_seen" && (!Number.isInteger(threshold) || threshold < 1)) {
    return { error: "threshold must be a whole number of events, at least 1" };
  }
  return threshold;
}

/** Fingerprints a first-seen alert has already sent for a mark: each is sent once. */
export function sentFingerprints(ruleId: string, markId: string): Set<string> {
  const rows = getDb()
    .query("SELECT e1 FROM alert_sent_fingerprints WHERE rule_id = ? AND mark_id = ?")
    .all(ruleId, markId) as Array<{ e1: string }>;
  return new Set(rows.map((row) => row.e1));
}

export function recordSentFingerprints(
  ruleId: string,
  markId: string,
  e1s: string[],
  at: number,
): void {
  const insert = getDb().query(
    "INSERT OR IGNORE INTO alert_sent_fingerprints (rule_id, mark_id, e1, sent_at) VALUES (?, ?, ?, ?)",
  );
  getDb().transaction(() => {
    for (const e1 of e1s) {
      insert.run(ruleId, markId, e1, at);
    }
  })();
}

/** A mark is watched for 24 hours; what was sent for it is not needed after that. */
export function pruneSentFingerprints(before: number): void {
  getDb().query("DELETE FROM alert_sent_fingerprints WHERE sent_at < ?").run(before);
}

function forgetSentFingerprints(ruleId: string): void {
  getDb().query("DELETE FROM alert_sent_fingerprints WHERE rule_id = ?").run(ruleId);
}

export function recordLastMark(ruleId: string, mark: AlertLastMark): void {
  getDb()
    .query("UPDATE alert_rules SET last_mark = ? WHERE id = ?")
    .run(JSON.stringify(mark), ruleId);
}

export function allAlertRules(db: Database = getDb()): AlertRule[] {
  return (
    db
      .query(`SELECT ${RULE_COLS} FROM alert_rules ORDER BY created_at DESC`)
      .all() as RuleRow[]
  ).map(mapRule);
}

export function enabledAlertRules(db: Database = getDb()): AlertRule[] {
  return (
    db
      .query(
        `SELECT ${RULE_COLS} FROM alert_rules WHERE enabled = 1 AND saved_search_id IS NOT NULL`,
      )
      .all() as RuleRow[]
  ).map(mapRule);
}

export function recordWebhookAttempt(
  id: string,
  attempt: { at: number; ok: boolean; status: string; error: string | null },
  db: Database = getDb(),
): void {
  const existing = getAlert(id, db);
  if (!existing) {
    return;
  }
  writeDelivery(id, nextDelivery(existing, attempt), db);
}

export function recordEvalAttempt(
  id: string,
  stamp: {
    at: number;
    status: "refused" | "error" | "ok";
    error: string | null;
  },
  db: Database = getDb(),
): void {
  const existing = getAlert(id, db);
  if (!existing) {
    return;
  }
  writeDelivery(id, nextEvalAttempt(existing, stamp), db);
}

function writeDelivery(
  id: string,
  next: {
    last_attempt_at: number;
    last_status: string | null;
    last_error: string | null;
    consecutive_failures: number;
    last_fired_at: number | null;
  },
  db: Database,
): void {
  db
    .query(
      `UPDATE alert_rules SET
         last_attempt_at = ?,
         last_status = ?,
         last_error = ?,
         consecutive_failures = ?,
         last_fired_at = ?
       WHERE id = ?`,
    )
    .run(
      next.last_attempt_at,
      next.last_status,
      next.last_error,
      next.consecutive_failures,
      next.last_fired_at,
      id,
    );
}

export function countAlertsForSavedSearch(savedSearchId: string): number {
  const row = getDb()
    .query("SELECT count(*) AS n FROM alert_rules WHERE saved_search_id = ?")
    .get(savedSearchId) as { n: number };
  return row.n;
}

export function getAlert(id: string, db: Database = getDb()): AlertRule | null {
  const row = db
    .query(`SELECT ${RULE_COLS} FROM alert_rules WHERE id = ?`)
    .get(id) as RuleRow | undefined;
  return row ? mapRule(row) : null;
}

export function parseWebhook(value: unknown): string | { error: string } {
  const webhook = typeof value === "string" ? value.trim() : "";
  if (webhook.length === 0 || !/^https?:\/\//.test(webhook)) {
    return { error: "webhook_url must be http(s)" };
  }
  return webhook;
}

export async function readJsonObject(
  c: Context,
): Promise<Record<string, unknown> | Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (!body || typeof body !== "object") {
    return c.json({ error: "Expected an object" }, 400);
  }
  return body as Record<string, unknown>;
}

export async function listAlertRules(c: Context): Promise<Response> {
  // Whether a call can link back (TOPOSCOPE_PUBLIC_URL), for the dialog's Slack preview.
  return c.json({ rules: allAlertRules(), link: publicUrl() !== null });
}

/** A monitor's fields, checked, as a create, an update or a replace gives them. */
export type MonitorFields = {
  name: string;
  kind: AlertKind;
  saved_search_id: string;
  query: string;
  webhook_url: string;
  threshold: number;
  body_kind: AlertBodyKind;
  body_template: string | null;
  resolved_body: string | null;
  remind_every: RemindId;
};

type FieldsError = { error: string; status: 400 | 404 };

/**
 * Read a monitor's fields. With `existing` (an update), a field left out keeps its value; without
 * it (a create, or a replace by name), a field left out takes its default.
 */
export function readMonitorFields(
  rec: Record<string, unknown>,
  existing: AlertRule | null,
): MonitorFields | FieldsError {
  const nameRaw = typeof rec.name === "string" ? rec.name.trim() : "";
  const name = nameRaw.length > 0 ? nameRaw : (existing?.name ?? "");
  if (name.length === 0) {
    return { error: "name is required", status: 400 };
  }
  let kind: AlertKind | null = existing?.kind ?? "threshold";
  if (rec.source !== undefined) {
    kind = rec.source === "search" ? "threshold" : rec.source === "fingerprints" ? "first_seen" : null;
    if (!kind) {
      return { error: "source must be search or fingerprints", status: 400 };
    }
  }
  if (rec.kind !== undefined) {
    kind = parseAlertKind(rec.kind);
    if (!kind) {
      return { error: "kind must be threshold or first_seen", status: 400 };
    }
  }
  let savedSearchId =
    typeof rec.saved_search_id === "string" && rec.saved_search_id.length > 0
      ? rec.saved_search_id
      : (existing?.saved_search_id ?? "");
  if (typeof rec.saved_search === "string" && rec.saved_search.trim() && !rec.saved_search_id) {
    const named = savedByName(rec.saved_search.trim());
    if ("error" in named) {
      return named;
    }
    savedSearchId = named.id;
  }
  if (savedSearchId.length === 0) {
    return { error: "saved_search_id is required", status: 400 };
  }
  const webhook =
    rec.webhook_url === undefined && existing
      ? (existing.webhook_url ?? "")
      : parseWebhook(rec.webhook_url);
  if (typeof webhook !== "string") {
    return { error: webhook.error, status: 400 };
  }
  if (webhook.length === 0) {
    return { error: "webhook_url must be http(s)", status: 400 };
  }
  const parsed =
    rec.threshold === undefined && existing ? existing.threshold : parseThreshold(rec.threshold);
  const threshold = typeof parsed === "number" ? kindThreshold(kind, parsed) : parsed;
  if (typeof threshold !== "number") {
    return { error: threshold.error, status: 400 };
  }
  const body = readBody(rec, kind, existing);
  if ("error" in body) {
    return { error: body.error, status: 400 };
  }
  const remind = readRemind(rec, existing);
  if (typeof remind !== "string") {
    return { error: remind.error, status: 400 };
  }
  const saved = getSaved(savedSearchId);
  if (!saved) {
    return { error: "Saved search not found", status: 404 };
  }
  if (saved.board) {
    return { error: boardWatchRefuse(saved), status: 400 };
  }
  return {
    name,
    kind,
    saved_search_id: savedSearchId,
    query: saved.query,
    webhook_url: webhook,
    threshold,
    ...body,
    remind_every: remind,
  };
}

function savedByName(name: string): { id: string } | FieldsError {
  const rows = getDb().query("SELECT id FROM saved_searches WHERE name = ?").all(name) as Array<{ id: string }>;
  if (rows.length === 0) {
    return { error: `No saved search is named ${name}`, status: 404 };
  }
  if (rows.length > 1) {
    return { error: `${rows.length} saved searches are named ${name}; give saved_search_id`, status: 400 };
  }
  return rows[0]!;
}

/** A new monitor: ok, with no stretches yet. */
export function insertMonitor(fields: MonitorFields, now = Date.now()): AlertRule {
  const id = crypto.randomUUID();
  getDb()
    .query(
      `INSERT INTO alert_rules
        (id, name, query, webhook_url, saved_search_id, threshold, enabled, last_fired_at, created_at, kind, body_kind, body_template,
         source, state, remind_every, resolved_body)
       VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?, 'ok', ?, ?)`,
    )
    .run(
      id,
      fields.name,
      fields.query,
      fields.webhook_url,
      fields.saved_search_id,
      fields.threshold,
      now,
      fields.kind,
      fields.body_kind,
      fields.body_template,
      sourceOfKind(fields.kind),
      fields.remind_every,
      fields.resolved_body,
    );
  return getAlert(id)!;
}

/**
 * Write a monitor's fields over what it was. When what it reads changes (its search, its source,
 * its threshold) while it is open, the stretch closes without a call.
 */
export function applyMonitorFields(existing: AlertRule, fields: MonitorFields, now = Date.now()): void {
  getDb()
    .query(
      `UPDATE alert_rules
       SET name = ?, query = ?, webhook_url = ?, saved_search_id = ?, threshold = ?, kind = ?, body_kind = ?, body_template = ?,
           source = ?, remind_every = ?, resolved_body = ?
       WHERE id = ?`,
    )
    .run(
      fields.name,
      fields.query,
      fields.webhook_url,
      fields.saved_search_id,
      fields.threshold,
      fields.kind,
      fields.body_kind,
      fields.body_template,
      sourceOfKind(fields.kind),
      fields.remind_every,
      fields.resolved_body,
      existing.id,
    );
  const readsAnew =
    fields.kind !== existing.kind ||
    fields.saved_search_id !== existing.saved_search_id ||
    fields.threshold !== existing.threshold;
  if (readsAnew && existing.state === "open") {
    closeByEdit(existing.id, now);
  }
  // What was sent was sent for that kind and that search.
  if (fields.kind !== existing.kind || fields.saved_search_id !== existing.saved_search_id) {
    forgetSentFingerprints(existing.id);
    getDb().query("UPDATE alert_rules SET last_mark = NULL WHERE id = ?").run(existing.id);
  }
  if (fields.webhook_url !== (existing.webhook_url ?? "")) {
    getDb()
      .query(
        `UPDATE alert_rules SET
           last_attempt_at = NULL,
           last_status = NULL,
           last_error = NULL,
           consecutive_failures = 0
         WHERE id = ?`,
      )
      .run(existing.id);
  }
}

/** Silence (`silence_for`, `silenced_until`) and pause (`enabled`): what an operator does to a monitor, not what it is. */
export function applyMonitorHold(existing: AlertRule, rec: Record<string, unknown>, now = Date.now()): void {
  let silencedUntil = existing.silenced_until;
  const silenceFor = parseSilenceFor(rec.silence_for);
  if (silenceFor) {
    silencedUntil = silencedUntilFrom(now, silenceFor);
  } else if (rec.silenced_until === null) {
    silencedUntil = null;
  } else if (typeof rec.silenced_until === "number" && Number.isFinite(rec.silenced_until)) {
    silencedUntil = Math.floor(rec.silenced_until);
  }
  if (silencedUntil !== existing.silenced_until) {
    getDb().query("UPDATE alert_rules SET silenced_until = ? WHERE id = ?").run(silencedUntil, existing.id);
  }
  if (typeof rec.enabled === "boolean" || rec.enabled === 0 || rec.enabled === 1) {
    const enabled = rec.enabled === true || rec.enabled === 1 ? 1 : 0;
    if (enabled !== existing.enabled) {
      getDb().query("UPDATE alert_rules SET enabled = ? WHERE id = ?").run(enabled, existing.id);
      // Paused while open: the stretch closes without a call.
      if (enabled === 0 && existing.state === "open") {
        closeByEdit(existing.id, now);
      }
    }
  }
}

/** A monitor and everything kept for it. */
export function removeMonitor(id: string): void {
  getDb().query("DELETE FROM alert_rules WHERE id = ?").run(id);
  forgetSentFingerprints(id);
  forgetMonitor(id);
}

export async function createAlertRule(c: Context): Promise<Response> {
  const rec = await readJsonObject(c);
  if (rec instanceof Response) {
    return rec;
  }
  if (typeof rec.name !== "string" || rec.name.trim().length === 0) {
    return c.json({ error: "name is required" }, 400);
  }
  if (typeof rec.saved_search_id !== "string" || rec.saved_search_id.length === 0) {
    return c.json({ error: "saved_search_id is required" }, 400);
  }
  const fields = readMonitorFields(rec, null);
  if ("error" in fields) {
    return c.json({ error: fields.error }, fields.status);
  }
  return c.json(insertMonitor(fields), 201);
}

export async function updateAlertRule(c: Context): Promise<Response> {
  const id = c.req.param("id");
  if (!id) {
    return c.json({ error: "id required" }, 400);
  }
  const existing = getAlert(id);
  if (!existing) {
    return c.json({ error: "Alert rule not found" }, 404);
  }
  const rec = await readJsonObject(c);
  if (rec instanceof Response) {
    return rec;
  }
  const fields = readMonitorFields(rec, existing);
  if ("error" in fields) {
    return c.json({ error: fields.error }, fields.status);
  }
  const now = Date.now();
  applyMonitorFields(existing, fields, now);
  applyMonitorHold(getAlert(id)!, rec, now);
  return c.json(getAlert(id));
}

export async function deleteAlertRule(c: Context): Promise<Response> {
  const id = c.req.param("id");
  if (!id) {
    return c.json({ error: "id required" }, 400);
  }
  if (!getAlert(id)) {
    return c.json({ error: "Alert rule not found" }, 404);
  }
  removeMonitor(id);
  return c.json({ ok: true });
}
