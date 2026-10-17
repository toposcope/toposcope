import type { Context } from "hono";
import { nextDelivery, nextEvalAttempt } from "../alerts/delivery";
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
  type AlertBodyKind,
} from "../shared/alert-body";

const RULE_COLS =
  "id, name, query, webhook_url, saved_search_id, threshold, enabled, last_fired_at, last_attempt_at, last_status, last_error, consecutive_failures, silenced_until, created_at, kind, last_mark, body_kind, body_template";

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
};

type RuleRow = Omit<AlertRule, "kind" | "last_mark" | "body_kind"> & {
  kind: string | null;
  last_mark: string | null;
  body_kind: string | null;
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
  existing: { body_kind: AlertBodyKind; body_template: string | null } | null,
): { body_kind: AlertBodyKind; body_template: string | null } | { error: string } {
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
  // A default body keeps the template, so switching back to Text or JSON finds it.
  return { body_kind: bodyKind, body_template: template };
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
  return {
    ...row,
    kind: parseAlertKind(row.kind) ?? "threshold",
    last_mark: parseLastMark(row.last_mark),
    body_kind: parseBodyKind(row.body_kind) ?? "default",
    body_template: row.body_template ?? null,
    threshold: Number(row.threshold),
    consecutive_failures: row.consecutive_failures ?? 0,
    silenced_until: row.silenced_until ?? null,
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

export function allAlertRules(): AlertRule[] {
  return (
    getDb()
      .query(`SELECT ${RULE_COLS} FROM alert_rules ORDER BY created_at DESC`)
      .all() as RuleRow[]
  ).map(mapRule);
}

export function enabledAlertRules(): AlertRule[] {
  return (
    getDb()
      .query(
        `SELECT ${RULE_COLS} FROM alert_rules WHERE enabled = 1 AND saved_search_id IS NOT NULL`,
      )
      .all() as RuleRow[]
  ).map(mapRule);
}

export function recordWebhookAttempt(
  id: string,
  attempt: { at: number; ok: boolean; status: string; error: string | null },
): void {
  const existing = getAlert(id);
  if (!existing) {
    return;
  }
  writeDelivery(id, nextDelivery(existing, attempt));
}

export function recordEvalAttempt(
  id: string,
  stamp: {
    at: number;
    status: "refused" | "error" | "ok";
    error: string | null;
  },
): void {
  const existing = getAlert(id);
  if (!existing) {
    return;
  }
  writeDelivery(id, nextEvalAttempt(existing, stamp));
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
): void {
  getDb()
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

export function getAlert(id: string): AlertRule | null {
  const row = getDb()
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

export async function createAlertRule(c: Context): Promise<Response> {
  const rec = await readJsonObject(c);
  if (rec instanceof Response) {
    return rec;
  }
  const name = typeof rec.name === "string" ? rec.name.trim() : "";
  const savedSearchId =
    typeof rec.saved_search_id === "string" ? rec.saved_search_id : "";
  const webhook = parseWebhook(rec.webhook_url);
  const kind = rec.kind === undefined ? "threshold" : parseAlertKind(rec.kind);
  if (!kind) {
    return c.json({ error: "kind must be threshold or first_seen" }, 400);
  }
  const parsed = parseThreshold(rec.threshold);
  const threshold = typeof parsed === "number" ? kindThreshold(kind, parsed) : parsed;
  if (name.length === 0) {
    return c.json({ error: "name is required" }, 400);
  }
  if (savedSearchId.length === 0) {
    return c.json({ error: "saved_search_id is required" }, 400);
  }
  if (typeof webhook !== "string") {
    return c.json({ error: webhook.error }, 400);
  }
  if (typeof threshold !== "number") {
    return c.json({ error: threshold.error }, 400);
  }
  const body = readBody(rec, kind, null);
  if ("error" in body) {
    return c.json({ error: body.error }, 400);
  }
  const saved = getSaved(savedSearchId);
  if (!saved) {
    return c.json({ error: "Saved search not found" }, 404);
  }
  if (saved.board) {
    return c.json({ error: boardWatchRefuse(saved) }, 400);
  }
  const rule: AlertRule = {
    id: crypto.randomUUID(),
    name,
    kind,
    last_mark: null,
    body_kind: body.body_kind,
    body_template: body.body_template,
    query: saved.query,
    webhook_url: webhook,
    saved_search_id: savedSearchId,
    threshold,
    enabled: 1,
    last_fired_at: null,
    last_attempt_at: null,
    last_status: null,
    last_error: null,
    consecutive_failures: 0,
    silenced_until: null,
    created_at: Date.now(),
  };
  getDb()
    .query(
      `INSERT INTO alert_rules
        (id, name, query, webhook_url, saved_search_id, threshold, enabled, last_fired_at, created_at, kind, body_kind, body_template)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      rule.id,
      rule.name,
      rule.query,
      rule.webhook_url,
      rule.saved_search_id,
      rule.threshold,
      rule.enabled,
      rule.last_fired_at,
      rule.created_at,
      rule.kind,
      rule.body_kind,
      rule.body_template,
    );
  return c.json(rule, 201);
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
  const nameRaw = typeof rec.name === "string" ? rec.name.trim() : "";
  const name = nameRaw.length > 0 ? nameRaw : existing.name;
  const savedSearchId =
    typeof rec.saved_search_id === "string" && rec.saved_search_id.length > 0
      ? rec.saved_search_id
      : (existing.saved_search_id ?? "");
  if (savedSearchId.length === 0) {
    return c.json({ error: "saved_search_id is required" }, 400);
  }
  const webhook =
    rec.webhook_url === undefined
      ? (existing.webhook_url ?? "")
      : parseWebhook(rec.webhook_url);
  if (typeof webhook !== "string") {
    return c.json({ error: webhook.error }, 400);
  }
  if (webhook.length === 0) {
    return c.json({ error: "webhook_url must be http(s)" }, 400);
  }
  const kind = rec.kind === undefined ? existing.kind : parseAlertKind(rec.kind);
  if (!kind) {
    return c.json({ error: "kind must be threshold or first_seen" }, 400);
  }
  const parsed =
    rec.threshold === undefined
      ? existing.threshold
      : parseThreshold(rec.threshold);
  const threshold = typeof parsed === "number" ? kindThreshold(kind, parsed) : parsed;
  if (typeof threshold !== "number") {
    return c.json({ error: threshold.error }, 400);
  }
  const body = readBody(rec, kind, existing);
  if ("error" in body) {
    return c.json({ error: body.error }, 400);
  }
  const saved = getSaved(savedSearchId);
  if (!saved) {
    return c.json({ error: "Saved search not found" }, 404);
  }
  if (saved.board) {
    return c.json({ error: boardWatchRefuse(saved) }, 400);
  }
  const webhookChanged = webhook !== (existing.webhook_url ?? "");
  let silencedUntil = existing.silenced_until;
  const silenceFor = parseSilenceFor(rec.silence_for);
  if (silenceFor) {
    silencedUntil = silencedUntilFrom(Date.now(), silenceFor);
  } else if (rec.silenced_until === null) {
    silencedUntil = null;
  } else if (typeof rec.silenced_until === "number" && Number.isFinite(rec.silenced_until)) {
    silencedUntil = Math.floor(rec.silenced_until);
  }
  getDb()
    .query(
      `UPDATE alert_rules
       SET name = ?, query = ?, webhook_url = ?, saved_search_id = ?, threshold = ?, silenced_until = ?, kind = ?, body_kind = ?, body_template = ?
       WHERE id = ?`,
    )
    .run(name, saved.query, webhook, savedSearchId, threshold, silencedUntil, kind, body.body_kind, body.body_template, id);
  // What was sent was sent for that kind and that search.
  if (kind !== existing.kind || savedSearchId !== existing.saved_search_id) {
    forgetSentFingerprints(id);
    getDb().query("UPDATE alert_rules SET last_mark = NULL WHERE id = ?").run(id);
  }
  if (webhookChanged) {
    getDb()
      .query(
        `UPDATE alert_rules SET
           last_attempt_at = NULL,
           last_status = NULL,
           last_error = NULL,
           consecutive_failures = 0
         WHERE id = ?`,
      )
      .run(id);
  }
  const updated = getAlert(id);
  return c.json(updated);
}

export async function deleteAlertRule(c: Context): Promise<Response> {
  const id = c.req.param("id");
  if (!id) {
    return c.json({ error: "id required" }, 400);
  }
  const existing = getDb()
    .query("SELECT id FROM alert_rules WHERE id = ?")
    .get(id) as { id: string } | undefined;
  if (!existing) {
    return c.json({ error: "Alert rule not found" }, 404);
  }
  getDb().query("DELETE FROM alert_rules WHERE id = ?").run(id);
  forgetSentFingerprints(id);
  return c.json({ ok: true });
}
