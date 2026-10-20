import type { Database } from "bun:sqlite";
import { getDb } from "../control/index";
import type { HttpResult } from "../shared/http-check";
import { parseStarttls, type Starttls } from "../shared/net-check";

/** The last run of a TCP or certificate monitor, as Watch and the editor read it (#180). */
export type NetLastRun = {
  at: number;
  result: HttpResult;
  /** Whether the port took the connection. */
  connected: boolean;
  duration_ms: number;
  /** The line that decided it, when one did. */
  line: string | null;
  /** Why it is not ok, in words. */
  why: string | null;
  /** When its certificate stops being valid, ISO; null on a TCP monitor or with no handshake. */
  cert_valid_to: string | null;
  /** The name its certificate was issued to. */
  cert_subject: string | null;
};

/** Where a TCP or certificate monitor connects, its conditions, and where its runs stand. */
export type NetSettings = {
  monitor_id: string;
  /** host:port. */
  target: string;
  /** A certificate monitor's STARTTLS; null for TLS from the first byte, and on a TCP monitor. */
  starttls: Starttls | null;
  every_ms: number;
  /** The stored lines, one condition each. */
  conditions: string;
  fail_after: number;
  fails_in_row: number;
  next_run_at: number | null;
  last_run: NetLastRun | null;
};

type Row = Omit<NetSettings, "starttls" | "last_run"> & { starttls: string | null; last_run: string | null };

const COLS = "monitor_id, target, starttls, every_ms, conditions, fail_after, fails_in_row, next_run_at, last_run";

function mapRow(row: Row): NetSettings {
  let last: NetLastRun | null = null;
  try {
    last = row.last_run ? (JSON.parse(row.last_run) as NetLastRun) : null;
  } catch {
    // An unreadable last run says nothing.
  }
  return { ...row, starttls: parseStarttls(row.starttls) ?? null, last_run: last };
}

export function getNet(monitorId: string, db: Database = getDb()): NetSettings | null {
  const row = db.query(`SELECT ${COLS} FROM monitor_net WHERE monitor_id = ?`).get(monitorId) as Row | undefined;
  return row ? mapRow(row) : null;
}

/** Enabled TCP and certificate monitors whose next run is due. */
export function dueNet(now: number, db: Database = getDb()): NetSettings[] {
  return (
    db
      .query(
        `SELECT ${COLS.split(", ").map((c) => `n.${c}`).join(", ")} FROM monitor_net n
         JOIN alert_rules r ON r.id = n.monitor_id
         WHERE r.enabled = 1 AND (n.next_run_at IS NULL OR n.next_run_at <= ?)
         ORDER BY n.next_run_at`,
      )
      .all(now) as Row[]
  ).map(mapRow);
}

export type NetWrite = Pick<NetSettings, "target" | "starttls" | "every_ms" | "conditions" | "fail_after">;

export function insertNet(monitorId: string, w: NetWrite, nextRunAt: number, db: Database = getDb()): void {
  db.query(
    `INSERT INTO monitor_net (monitor_id, target, starttls, every_ms, conditions, fail_after, next_run_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(monitorId, w.target, w.starttls, w.every_ms, w.conditions, w.fail_after, nextRunAt);
}

/** Where it connects, or how often. `restart`: it reads anew, so its run of failures starts over and it runs now. */
export function updateNet(
  monitorId: string,
  w: NetWrite,
  next: { nextRunAt: number; restart: boolean },
  db: Database = getDb(),
): void {
  db.query(
    `UPDATE monitor_net SET target = ?, starttls = ?, every_ms = ?, conditions = ?, fail_after = ?, next_run_at = ?,
       fails_in_row = CASE WHEN ? THEN 0 ELSE fails_in_row END
     WHERE monitor_id = ?`,
  ).run(w.target, w.starttls, w.every_ms, w.conditions, w.fail_after, next.nextRunAt, next.restart ? 1 : 0, monitorId);
}

export function setNetNextRun(monitorId: string, at: number, db: Database = getDb()): void {
  db.query("UPDATE monitor_net SET next_run_at = ? WHERE monitor_id = ?").run(at, monitorId);
}

export function noteNetRun(monitorId: string, failsInRow: number, run: NetLastRun, db: Database = getDb()): void {
  db.query("UPDATE monitor_net SET fails_in_row = ?, last_run = ? WHERE monitor_id = ?").run(
    failsInRow,
    JSON.stringify(run),
    monitorId,
  );
}

export function forgetNet(monitorId: string, db: Database = getDb()): void {
  db.query("DELETE FROM monitor_net WHERE monitor_id = ?").run(monitorId);
}
