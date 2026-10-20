import type { Database } from "bun:sqlite";
import { getDb } from "../control/index";
import type { HttpMethod, HttpResult } from "../shared/http-check";

/** The last run of an HTTP(S) monitor, as Watch and the editor read it (#178). */
export type HttpLastRun = {
  at: number;
  result: HttpResult;
  /** Null when nothing answered. */
  status: number | null;
  duration_ms: number;
  /** The line that decided it, when one did. */
  line: string | null;
  /** Why it is not ok, in words. */
  why: string | null;
  /** When its certificate stops being valid, ISO; null over http or with no answer. */
  cert_valid_to: string | null;
};

/** What an HTTP(S) monitor calls, its conditions, and where its runs stand. */
export type HttpSettings = {
  monitor_id: string;
  url: string;
  method: HttpMethod;
  /** Sent with a POST. */
  body: string | null;
  /** Kept as a webhook URL is: sent, never shown back. */
  headers: Array<[string, string]>;
  every_ms: number;
  /** The stored lines, one condition each. */
  conditions: string;
  fail_after: number;
  fails_in_row: number;
  next_run_at: number | null;
  last_run: HttpLastRun | null;
};

type Row = Omit<HttpSettings, "method" | "headers" | "last_run"> & {
  method: string;
  headers: string;
  last_run: string | null;
};

const COLS =
  "monitor_id, url, method, body, headers, every_ms, conditions, fail_after, fails_in_row, next_run_at, last_run";

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function mapRow(row: Row): HttpSettings {
  const headers = parseJson<unknown>(row.headers, []);
  return {
    ...row,
    method: row.method === "HEAD" || row.method === "POST" ? row.method : "GET",
    headers: Array.isArray(headers)
      ? headers.filter(
          (h): h is [string, string] => Array.isArray(h) && typeof h[0] === "string" && typeof h[1] === "string",
        )
      : [],
    last_run: parseJson<HttpLastRun | null>(row.last_run, null),
  };
}

export function getHttp(monitorId: string, db: Database = getDb()): HttpSettings | null {
  const row = db.query(`SELECT ${COLS} FROM monitor_http WHERE monitor_id = ?`).get(monitorId) as Row | undefined;
  return row ? mapRow(row) : null;
}

/** Enabled HTTP(S) monitors whose next run is due. */
export function dueHttp(now: number, db: Database = getDb()): HttpSettings[] {
  return (
    db
      .query(
        `SELECT ${COLS.split(", ").map((c) => `h.${c}`).join(", ")} FROM monitor_http h
         JOIN alert_rules r ON r.id = h.monitor_id
         WHERE r.enabled = 1 AND (h.next_run_at IS NULL OR h.next_run_at <= ?)
         ORDER BY h.next_run_at`,
      )
      .all(now) as Row[]
  ).map(mapRow);
}

export type HttpWrite = Pick<
  HttpSettings,
  "url" | "method" | "body" | "headers" | "every_ms" | "conditions" | "fail_after"
>;

export function insertHttp(monitorId: string, w: HttpWrite, nextRunAt: number, db: Database = getDb()): void {
  db.query(
    `INSERT INTO monitor_http (monitor_id, url, method, body, headers, every_ms, conditions, fail_after, next_run_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(monitorId, w.url, w.method, w.body, JSON.stringify(w.headers), w.every_ms, w.conditions, w.fail_after, nextRunAt);
}

/** What it calls, or how often. `restart`: it reads anew, so its run of failures starts over and it runs now. */
export function updateHttp(
  monitorId: string,
  w: HttpWrite,
  next: { nextRunAt: number; restart: boolean },
  db: Database = getDb(),
): void {
  db.query(
    `UPDATE monitor_http SET url = ?, method = ?, body = ?, headers = ?, every_ms = ?, conditions = ?, fail_after = ?,
       next_run_at = ?, fails_in_row = CASE WHEN ? THEN 0 ELSE fails_in_row END
     WHERE monitor_id = ?`,
  ).run(
    w.url,
    w.method,
    w.body,
    JSON.stringify(w.headers),
    w.every_ms,
    w.conditions,
    w.fail_after,
    next.nextRunAt,
    next.restart ? 1 : 0,
    monitorId,
  );
}

export function setNextRun(monitorId: string, at: number, db: Database = getDb()): void {
  db.query("UPDATE monitor_http SET next_run_at = ? WHERE monitor_id = ?").run(at, monitorId);
}

export function noteHttpRun(monitorId: string, failsInRow: number, run: HttpLastRun, db: Database = getDb()): void {
  db.query("UPDATE monitor_http SET fails_in_row = ?, last_run = ? WHERE monitor_id = ?").run(
    failsInRow,
    JSON.stringify(run),
    monitorId,
  );
}

export function forgetHttp(monitorId: string, db: Database = getDb()): void {
  db.query("DELETE FROM monitor_http WHERE monitor_id = ?").run(monitorId);
}
