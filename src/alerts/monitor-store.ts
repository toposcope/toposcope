import type { Database } from "bun:sqlite";
import { getDb } from "../control/index";
import { keptStretches, type MonitorResult } from "../shared/monitor";
import { keptResultsMs } from "../shared/push";

/** What became of a stretch's open or resolved call. Null while it is still to be sent. */
export type CallState = "sent" | "failed" | "silenced" | "none";

/** A call: opened, a reminder, resolved, or one new-fingerprints call (`sent`, outside any stretch). */
export type CallWhat = "open" | "reminder" | "resolved" | "sent";

export type MonitorCall = {
  id: number;
  monitor_id: string;
  stretch_id: string | null;
  at: number;
  what: CallWhat;
  /** HTTP status, `timeout`, `error`, or `silenced` when silencing kept it from being sent. */
  status: string;
  ok: boolean;
  error: string | null;
};

/** One open-to-resolved stretch of a monitor. */
export type MonitorStretch = {
  id: string;
  monitor_id: string;
  opened_at: number;
  resolved_at: number | null;
  /** `ok`: the first ok result after it. `edit`: what it reads was changed, or it was paused. */
  closed_by: "ok" | "edit" | null;
  open_value: number | null;
  open_count: number | null;
  /** The result that opened it, in words (`{{message}}`). */
  open_message: string;
  last_value: number | null;
  last_count: number | null;
  last_at: number;
  /** When the open call or the last reminder went out (or was kept back by a silence). */
  called_at: number | null;
  open_call: CallState | null;
  resolved_call: CallState | null;
  /** A push monitor that opened because a result never came: when that result was due (#177). */
  due_at: number | null;
};

export type StretchWithCalls = MonitorStretch & { calls: MonitorCall[] };

/** What a pass read, or a pushed result said: a value and a count when it has them, and in words. */
export type Reading = { value: number | null; count: number | null; message: string };

const STRETCH_COLS =
  "id, monitor_id, opened_at, resolved_at, closed_by, open_value, open_count, open_message, last_value, last_count, last_at, called_at, open_call, resolved_call, due_at";

type CallRow = Omit<MonitorCall, "ok"> & { ok: number };

function mapCall(row: CallRow): MonitorCall {
  return { ...row, ok: row.ok === 1 };
}

export function openStretch(monitorId: string, db: Database = getDb()): MonitorStretch | null {
  const row = db
    .query(
      `SELECT ${STRETCH_COLS} FROM monitor_stretches WHERE monitor_id = ? AND resolved_at IS NULL ORDER BY opened_at DESC LIMIT 1`,
    )
    .get(monitorId) as MonitorStretch | undefined;
  return row ?? null;
}

export function getStretch(id: string, db: Database = getDb()): MonitorStretch | null {
  const row = db
    .query(`SELECT ${STRETCH_COLS} FROM monitor_stretches WHERE id = ?`)
    .get(id) as MonitorStretch | undefined;
  return row ?? null;
}

/** The monitor's last result, whatever it was: an ok, a warn or a fail. */
export function recordResult(
  monitorId: string,
  result: MonitorResult,
  value: number | null,
  at: number,
  db: Database = getDb(),
): void {
  db.query("UPDATE alert_rules SET last_result = ?, last_value = ?, last_result_at = ? WHERE id = ?").run(
    result,
    value,
    at,
    monitorId,
  );
}

/** A fail while ok: the monitor opens, and a stretch starts. A missed result says when it was due. */
export function beginStretch(
  monitorId: string,
  at: number,
  reading: Reading,
  db: Database = getDb(),
  dueAt: number | null = null,
): MonitorStretch {
  const id = crypto.randomUUID();
  db.transaction(() => {
    db.query(
      `INSERT INTO monitor_stretches
        (id, monitor_id, opened_at, open_value, open_count, open_message, last_value, last_count, last_at, due_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, monitorId, at, reading.value, reading.count, reading.message, reading.value, reading.count, at, dueAt);
    db.query("UPDATE alert_rules SET state = 'open' WHERE id = ?").run(monitorId);
    pruneStretches(monitorId, db);
  })();
  return getStretch(id, db)!;
}

/** A fail while open: still open, with this reading. */
export function noteReading(stretchId: string, at: number, reading: Reading, db: Database = getDb()): void {
  db.query("UPDATE monitor_stretches SET last_value = ?, last_count = ?, last_at = ? WHERE id = ?").run(
    reading.value,
    reading.count,
    at,
    stretchId,
  );
}

/** The first ok while open: it resolves. An open call still unsent is not tried again. */
export function resolveStretch(
  monitorId: string,
  stretchId: string,
  at: number,
  reading: Reading,
  db: Database = getDb(),
): void {
  db.transaction(() => {
    db.query(
      `UPDATE monitor_stretches SET resolved_at = ?, closed_by = 'ok', last_value = ?, last_count = ?, last_at = ?,
         open_call = COALESCE(open_call, 'failed')
       WHERE id = ?`,
    ).run(at, reading.value, reading.count, at, stretchId);
    db.query("UPDATE alert_rules SET state = 'ok' WHERE id = ?").run(monitorId);
  })();
}

/**
 * What it reads was changed, or it was paused, while open: the stretch closes without a call
 * ("closed by edit"), and the monitor is ok until its next result says otherwise.
 */
export function closeByEdit(monitorId: string, at: number, db: Database = getDb()): void {
  db.transaction(() => {
    db.query(
      `UPDATE monitor_stretches SET resolved_at = ?, closed_by = 'edit',
         open_call = COALESCE(open_call, 'none'), resolved_call = 'none'
       WHERE monitor_id = ? AND resolved_at IS NULL`,
    ).run(at, monitorId);
    db.query("UPDATE alert_rules SET state = 'ok' WHERE id = ?").run(monitorId);
  })();
}

export function setOpenCall(stretchId: string, state: CallState, calledAt: number, db: Database = getDb()): void {
  db.query("UPDATE monitor_stretches SET open_call = ?, called_at = ? WHERE id = ?").run(state, calledAt, stretchId);
}

export function setCalledAt(stretchId: string, at: number, db: Database = getDb()): void {
  db.query("UPDATE monitor_stretches SET called_at = ? WHERE id = ?").run(at, stretchId);
}

export function setResolvedCall(stretchId: string, state: CallState, db: Database = getDb()): void {
  db.query("UPDATE monitor_stretches SET resolved_call = ? WHERE id = ?").run(state, stretchId);
}

/** Resolved stretches whose resolved call is still to be sent. */
export function pendingResolved(monitorId: string, db: Database = getDb()): MonitorStretch[] {
  return db
    .query(
      `SELECT ${STRETCH_COLS} FROM monitor_stretches
       WHERE monitor_id = ? AND closed_by = 'ok' AND resolved_call IS NULL ORDER BY opened_at`,
    )
    .all(monitorId) as MonitorStretch[];
}

export function recordCall(call: Omit<MonitorCall, "id">, db: Database = getDb()): void {
  db.query(
    "INSERT INTO monitor_calls (monitor_id, stretch_id, at, what, status, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(call.monitor_id, call.stretch_id, call.at, call.what, call.status, call.ok ? 1 : 0, call.error);
}

function withCalls(stretches: MonitorStretch[], db: Database): StretchWithCalls[] {
  if (stretches.length === 0) {
    return [];
  }
  const ids = stretches.map((s) => s.id);
  const calls = (
    db
      .query(
        `SELECT id, monitor_id, stretch_id, at, what, status, ok, error FROM monitor_calls
         WHERE stretch_id IN (${ids.map(() => "?").join(", ")}) ORDER BY at, id`,
      )
      .all(...ids) as CallRow[]
  ).map(mapCall);
  const by = new Map<string, MonitorCall[]>();
  for (const call of calls) {
    by.set(call.stretch_id!, [...(by.get(call.stretch_id!) ?? []), call]);
  }
  return stretches.map((s) => ({ ...s, calls: by.get(s.id) ?? [] }));
}

/** Stretches that were open at any time in [from, to], each with its calls. */
export function stretchesBetween(fromMs: number, toMs: number, db: Database = getDb()): StretchWithCalls[] {
  const rows = db
    .query(
      `SELECT ${STRETCH_COLS} FROM monitor_stretches
       WHERE opened_at <= ? AND (resolved_at IS NULL OR resolved_at >= ?) ORDER BY opened_at`,
    )
    .all(toMs, fromMs) as MonitorStretch[];
  return withCalls(rows, db);
}

/** A monitor's last stretches, newest first, each with its calls. */
export function monitorHistory(monitorId: string, limit = keptStretches, db: Database = getDb()): StretchWithCalls[] {
  const rows = db
    .query(`SELECT ${STRETCH_COLS} FROM monitor_stretches WHERE monitor_id = ? ORDER BY opened_at DESC LIMIT ?`)
    .all(monitorId, limit) as MonitorStretch[];
  return withCalls(rows, db);
}

/** New-fingerprints calls in [from, to]: they are sent outside any stretch. */
export function sentCallsBetween(fromMs: number, toMs: number, db: Database = getDb()): MonitorCall[] {
  return (
    db
      .query(
        `SELECT id, monitor_id, stretch_id, at, what, status, ok, error FROM monitor_calls
         WHERE stretch_id IS NULL AND at >= ? AND at <= ? ORDER BY at, id`,
      )
      .all(fromMs, toMs) as CallRow[]
  ).map(mapCall);
}

/** Keep the last 200 stretches a monitor, and its last 200 calls sent outside a stretch. */
export function pruneStretches(monitorId: string, db: Database = getDb()): void {
  db.query(
    `DELETE FROM monitor_calls WHERE monitor_id = ? AND stretch_id IN (
       SELECT id FROM monitor_stretches WHERE monitor_id = ? ORDER BY opened_at DESC LIMIT -1 OFFSET ?)`,
  ).run(monitorId, monitorId, keptStretches);
  db.query(
    `DELETE FROM monitor_stretches WHERE id IN (
       SELECT id FROM monitor_stretches WHERE monitor_id = ? ORDER BY opened_at DESC LIMIT -1 OFFSET ?)`,
  ).run(monitorId, keptStretches);
  db.query(
    `DELETE FROM monitor_calls WHERE id IN (
       SELECT id FROM monitor_calls WHERE monitor_id = ? AND stretch_id IS NULL ORDER BY at DESC, id DESC LIMIT -1 OFFSET ?)`,
  ).run(monitorId, keptStretches);
}

/** A deleted monitor takes its record with it. */
export function forgetMonitor(monitorId: string, db: Database = getDb()): void {
  db.query("DELETE FROM monitor_calls WHERE monitor_id = ?").run(monitorId);
  db.query("DELETE FROM monitor_stretches WHERE monitor_id = ?").run(monitorId);
  db.query("DELETE FROM monitor_results WHERE monitor_id = ?").run(monitorId);
}

/** One result as Watch draws it (#177): a tick at its time, a bar back to its `/start`. */
export type PushResultRow = {
  id: number;
  monitor_id: string;
  at: number;
  result: "ok" | "warn" | "fail";
  exit_code: number | null;
  duration_ms: number | null;
  value: number | null;
  unit: string | null;
  message: string;
  host: string;
  via: string;
};

const RESULT_COLS = "id, monitor_id, at, result, exit_code, duration_ms, value, unit, message, host, via";

/** How bad a result is: within a minute the worst is kept, and of equals the later. */
const STATUS_RANK = "CASE {s} WHEN 'fail' THEN 2 WHEN 'warn' THEN 1 ELSE 0 END";
const rank = (col: string) => STATUS_RANK.replace("{s}", col);

/** A result for Watch's ticks: one row a monitor a minute, the worst of the minute winning. */
export function recordPushResult(row: Omit<PushResultRow, "id">, db: Database = getDb()): void {
  db.query(
    `INSERT INTO monitor_results (monitor_id, minute, at, result, exit_code, duration_ms, value, unit, message, host, via)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (monitor_id, minute) DO UPDATE SET
       at = excluded.at, result = excluded.result, exit_code = excluded.exit_code, duration_ms = excluded.duration_ms,
       value = excluded.value, unit = excluded.unit, message = excluded.message, host = excluded.host, via = excluded.via
     WHERE ${rank("excluded.result")} >= ${rank("monitor_results.result")}`,
  ).run(
    row.monitor_id,
    Math.floor(row.at / 60_000),
    row.at,
    row.result,
    row.exit_code,
    row.duration_ms,
    row.value,
    row.unit,
    row.message,
    row.host,
    row.via,
  );
}

/** A push monitor's last result as Watch keeps it: the worst of its last minute. */
export function lastPushResult(monitorId: string, db: Database = getDb()): PushResultRow | null {
  const row = db
    .query(`SELECT ${RESULT_COLS} FROM monitor_results WHERE monitor_id = ? ORDER BY at DESC, id DESC LIMIT 1`)
    .get(monitorId) as PushResultRow | undefined;
  return row ?? null;
}

/** Columns a lane's results are read in: within each, the worst result, and of equals the later. */
export const laneColumns = 240;
/** A message as a lane's tick carries it; the whole one is its log row. */
const tickMessage = 300;

/**
 * Results in [from, to] for Watch's lanes, cut into 240 columns a monitor: each column that has
 * any is the worst result in it, the later of equals.
 */
export function resultsBetween(fromMs: number, toMs: number, db: Database = getDb()): PushResultRow[] {
  const span = Math.max(1, toMs - fromMs);
  const rows = db
    .query(
      `SELECT ${RESULT_COLS} FROM (
         SELECT ${RESULT_COLS}, ROW_NUMBER() OVER (
           PARTITION BY monitor_id, MIN(${laneColumns - 1}, (at - ?) * ${laneColumns} / ?)
           ORDER BY ${rank("result")} DESC, at DESC, id DESC
         ) AS n
         FROM monitor_results WHERE at >= ? AND at <= ?
       ) WHERE n = 1 ORDER BY monitor_id, at`,
    )
    .all(fromMs, span, fromMs, toMs) as PushResultRow[];
  return rows.map((row) =>
    row.message.length > tickMessage ? { ...row, message: `${row.message.slice(0, tickMessage)}…` } : row,
  );
}

/** Results older than 30 days go. */
export function pruneResults(now: number, db: Database = getDb()): void {
  db.query("DELETE FROM monitor_results WHERE at < ?").run(now - keptResultsMs);
}
