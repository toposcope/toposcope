import { stampCreated, stampUpdated } from "./actors";
import type { Database } from "bun:sqlite";
import { closeByEdit } from "../alerts/monitor-store";
import type { AlertBodyKind } from "../shared/alert-body";
import { defaultRemind, type RemindId } from "../shared/monitor";
import {
  isPingKey,
  maxPushMonitors,
  monitorQuery,
  parseEvery,
  parseGrace,
  parsePushName,
} from "../shared/push";
import { getAlert, parseWebhook, readBody, readRemind, type AlertRule } from "./alerts";
import { getDb } from "./index";
import type { MonitorPlace } from "./monitor-place";

/** A push monitor's fields, as a create, a replace or an update gives them (#177). */
export type PushFields = {
  name: string;
  every_ms: number | null;
  grace_ms: number | null;
  /** Null: the default webhook from Settings, if one is set. */
  webhook_url: string | null;
  remind_every: RemindId;
  body_kind: AlertBodyKind;
  body_template: string | null;
  resolved_body: string | null;
  /** A key the editor minted; null keeps the one it has, or mints one. */
  key: string | null;
};

type FieldsError = { error: string; status: 400 };

/**
 * Read a push monitor's fields. With `existing` (an update), a field left out keeps its value;
 * without it (a create, or a replace by name), a field left out takes its default.
 */
export function readPushFields(rec: Record<string, unknown>, existing: AlertRule | null): PushFields | FieldsError {
  const name = rec.name === undefined && existing ? existing.name : parsePushName(rec.name);
  if (typeof name !== "string") {
    return { error: name.error, status: 400 };
  }
  let everyMs = existing?.every_ms ?? null;
  if (rec.every !== undefined) {
    if (rec.every === null || rec.every === "") {
      everyMs = null;
    } else {
      everyMs = parseEvery(rec.every);
      if (everyMs === null) {
        return { error: "every must be a span from 30s to 365d, like 5m, 1h or 1d", status: 400 };
      }
    }
  } else if (!existing) {
    everyMs = null;
  }
  let graceMs = existing?.grace_ms ?? null;
  if (rec.grace !== undefined) {
    if (rec.grace === null || rec.grace === "") {
      graceMs = null;
    } else {
      graceMs = parseGrace(rec.grace);
      if (graceMs === null) {
        return { error: "grace must be a span up to 365d, like 2m or 1h, or 0", status: 400 };
      }
    }
  } else if (!existing) {
    graceMs = null;
  }
  let webhook: string | null = existing?.webhook_url ?? null;
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
  const remind = readRemind(rec, existing);
  if (typeof remind !== "string") {
    return { error: remind.error, status: 400 };
  }
  const body = readBody(rec, "threshold", existing);
  if ("error" in body) {
    return { error: body.error, status: 400 };
  }
  let key: string | null = null;
  if (rec.key !== undefined && rec.key !== null) {
    if (typeof rec.key !== "string" || !isPingKey(rec.key)) {
      return { error: "key must be a random UUID", status: 400 };
    }
    key = rec.key;
  }
  return {
    name,
    every_ms: everyMs,
    grace_ms: graceMs,
    webhook_url: webhook,
    remind_every: remind,
    ...body,
    key,
  };
}

export function countPushMonitors(db: Database = getDb()): number {
  return (db.query("SELECT count(*) AS n FROM alert_rules WHERE source = 'push'").get() as { n: number }).n;
}

/** Why another push monitor cannot be made, or null when it can. */
export function pushCapProblem(adding: number, db: Database = getDb()): string | null {
  const have = countPushMonitors(db);
  return have + adding > maxPushMonitors
    ? `${maxPushMonitors} push monitors is the most there can be; delete one in Watch, or send to a monitor that exists`
    : null;
}

/** A key nobody else holds: the editor's, when it minted one, else a fresh one. */
function freshKey(wanted: string | null, db: Database): string | { error: string } {
  if (wanted) {
    const taken = db.query("SELECT 1 FROM alert_rules WHERE ping_key = ?").get(wanted);
    return taken ? { error: "key is taken" } : wanted;
  }
  return crypto.randomUUID();
}

/** A new push monitor: ok, with a keyed URL, its next result due counted from now. */
export function insertPushMonitor(
  fields: PushFields,
  place: MonitorPlace,
  now = Date.now(),
  db: Database = getDb(),
): AlertRule | { error: string } {
  const key = freshKey(fields.key, db);
  if (typeof key !== "string") {
    return key;
  }
  const id = crypto.randomUUID();
  db.query(
    `INSERT INTO alert_rules
      (id, name, query, webhook_url, saved_search_id, threshold, enabled, last_fired_at, created_at, kind, body_kind, body_template,
       source, state, remind_every, resolved_body, ping_key, every_ms, grace_ms, due_from, service, host)
     VALUES (?, ?, ?, ?, NULL, 1, 1, NULL, ?, 'threshold', ?, ?, 'push', 'ok', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    fields.name,
    monitorQuery(fields.name),
    fields.webhook_url,
    now,
    fields.body_kind,
    fields.body_template,
    fields.remind_every,
    fields.resolved_body,
    key,
    fields.every_ms,
    fields.grace_ms,
    now,
    place.service,
    place.host,
  );
  stampCreated("alert_rules", id, db);
  return getAlert(id, db)!;
}

/** A monitor created by its first result (#177): its name, and `every` / `grace` when the result said. */
export function pushFieldsOfResult(name: string, everyMs: number | null, graceMs: number | null): PushFields {
  return {
    name,
    every_ms: everyMs,
    grace_ms: graceMs,
    webhook_url: null,
    remind_every: defaultRemind,
    body_kind: "default",
    body_template: null,
    resolved_body: null,
    key: null,
  };
}

/**
 * Write a push monitor's fields over what it was. A new schedule counts its next result from
 * now; a new name is a new `monitor:` query; a new key replaces the old one, which then gets 404.
 */
export function applyPushFields(
  existing: AlertRule,
  fields: PushFields,
  now = Date.now(),
  db: Database = getDb(),
): { error: string } | null {
  stampUpdated("alert_rules", existing.id, db);
  if (fields.key && fields.key !== pingKeyOf(existing.id, db)) {
    const key = freshKey(fields.key, db);
    if (typeof key !== "string") {
      return key;
    }
    db.query("UPDATE alert_rules SET ping_key = ? WHERE id = ?").run(key, existing.id);
  }
  const schedule = fields.every_ms !== existing.every_ms || fields.grace_ms !== existing.grace_ms;
  db.query(
    `UPDATE alert_rules
     SET name = ?, query = ?, webhook_url = ?, body_kind = ?, body_template = ?, remind_every = ?, resolved_body = ?,
         every_ms = ?, grace_ms = ?, due_from = CASE WHEN ? THEN ? ELSE due_from END
     WHERE id = ?`,
  ).run(
    fields.name,
    monitorQuery(fields.name),
    fields.webhook_url,
    fields.body_kind,
    fields.body_template,
    fields.remind_every,
    fields.resolved_body,
    fields.every_ms,
    fields.grace_ms,
    schedule ? 1 : 0,
    now,
    existing.id,
  );
  // Opened because a result was missed: with no schedule now, nothing is missed.
  if (fields.every_ms === null && existing.every_ms !== null && existing.state === "open") {
    const open = db
      .query("SELECT due_at FROM monitor_stretches WHERE monitor_id = ? AND resolved_at IS NULL")
      .get(existing.id) as { due_at: number | null } | undefined;
    if (open && open.due_at !== null) {
      closeByEdit(existing.id, now, db);
    }
  }
  if (fields.webhook_url !== existing.webhook_url) {
    db.query(
      "UPDATE alert_rules SET last_attempt_at = NULL, last_status = NULL, last_error = NULL, consecutive_failures = 0 WHERE id = ?",
    ).run(existing.id);
  }
  return null;
}

/** A push monitor's key: printed only on its own page (`GET /api/monitors/<name>`) and in its editor. */
export function pingKeyOf(id: string, db: Database = getDb()): string | null {
  const row = db.query("SELECT ping_key FROM alert_rules WHERE id = ?").get(id) as { ping_key: string | null } | undefined;
  return row?.ping_key ?? null;
}

/** Every push monitor's key, to compare a ping's against each in constant time. */
export function pushKeys(db: Database = getDb()): Array<{ id: string; key: string }> {
  return (
    db.query("SELECT id, ping_key FROM alert_rules WHERE source = 'push' AND ping_key IS NOT NULL").all() as Array<{
      id: string;
      ping_key: string;
    }>
  ).map((row) => ({ id: row.id, key: row.ping_key }));
}
