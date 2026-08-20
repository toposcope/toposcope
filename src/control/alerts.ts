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

const RULE_COLS =
  "id, name, query, webhook_url, saved_search_id, threshold, enabled, last_fired_at, last_attempt_at, last_status, last_error, consecutive_failures, silenced_until, created_at";

export type AlertRule = {
  id: string;
  name: string;
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

function mapRule(row: AlertRule): AlertRule {
  return {
    ...row,
    threshold: Number(row.threshold),
    consecutive_failures: row.consecutive_failures ?? 0,
    silenced_until: row.silenced_until ?? null,
  };
}

export function allAlertRules(): AlertRule[] {
  return (
    getDb()
      .query(`SELECT ${RULE_COLS} FROM alert_rules ORDER BY created_at DESC`)
      .all() as AlertRule[]
  ).map(mapRule);
}

export function enabledAlertRules(): AlertRule[] {
  return (
    getDb()
      .query(
        `SELECT ${RULE_COLS} FROM alert_rules WHERE enabled = 1 AND saved_search_id IS NOT NULL`,
      )
      .all() as AlertRule[]
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
    .get(id) as AlertRule | undefined;
  return row ? mapRule(row) : null;
}

function parseWebhook(value: unknown): string | { error: string } {
  const webhook = typeof value === "string" ? value.trim() : "";
  if (webhook.length === 0 || !/^https?:\/\//.test(webhook)) {
    return { error: "webhook_url must be http(s)" };
  }
  return webhook;
}

async function readJsonObject(
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
  return c.json({ rules: allAlertRules() });
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
  const threshold = parseThreshold(rec.threshold);
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
        (id, name, query, webhook_url, saved_search_id, threshold, enabled, last_fired_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  const threshold =
    rec.threshold === undefined
      ? existing.threshold
      : parseThreshold(rec.threshold);
  if (typeof threshold !== "number") {
    return c.json({ error: threshold.error }, 400);
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
       SET name = ?, query = ?, webhook_url = ?, saved_search_id = ?, threshold = ?, silenced_until = ?
       WHERE id = ?`,
    )
    .run(name, saved.query, webhook, savedSearchId, threshold, silencedUntil, id);
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
  return c.json({ ok: true });
}
