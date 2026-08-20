import { mkdirSync } from "node:fs";
import { Database } from "bun:sqlite";
import { pingClickHouse } from "../shared/clickhouse";
import { defaultSqlitePath } from "../shared/sqlite-path";

export type Health = {
  ok: boolean;
  clickhouse: boolean;
  sqlite: boolean;
};

let db: Database | null = null;

function sqlitePath(): string {
  return defaultSqlitePath();
}

export function getDb(): Database {
  if (db) {
    return db;
  }
  const path = sqlitePath();
  if (path !== ":memory:" && path.includes("/")) {
    const dir = path.slice(0, path.lastIndexOf("/"));
    if (dir) {
      mkdirp(dir);
    }
  }
  db = new Database(path);
  db.run("PRAGMA journal_mode = WAL;");
  db.run(`
    CREATE TABLE IF NOT EXISTS saved_searches (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      query TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS alert_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      query TEXT NOT NULL,
      webhook_url TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  addColumnIfMissing(db, "saved_searches", "from_ts", "TEXT");
  addColumnIfMissing(db, "saved_searches", "to_ts", "TEXT");
  addColumnIfMissing(db, "saved_searches", "range", "TEXT");
  addColumnIfMissing(db, "saved_searches", "agg", "TEXT");
  addColumnIfMissing(db, "saved_searches", "widgets", "TEXT");
  addColumnIfMissing(db, "saved_searches", "board", "TEXT");
  addColumnIfMissing(db, "saved_searches", "cols", "TEXT");
  addColumnIfMissing(db, "alert_rules", "saved_search_id", "TEXT");
  addColumnIfMissing(db, "alert_rules", "threshold", "REAL NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "alert_rules", "enabled", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "alert_rules", "last_fired_at", "INTEGER");
  addColumnIfMissing(db, "alert_rules", "last_attempt_at", "INTEGER");
  addColumnIfMissing(db, "alert_rules", "last_status", "TEXT");
  addColumnIfMissing(db, "alert_rules", "last_error", "TEXT");
  addColumnIfMissing(db, "alert_rules", "consecutive_failures", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "alert_rules", "silenced_until", "INTEGER");
  ensureRealThreshold(db);
  db.run(`
    CREATE TABLE IF NOT EXISTS api_tokens (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS field_roles (
      key TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK (role IN ('chart', 'lookup', 'ignore'))
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS field_links (
      log_key TEXT PRIMARY KEY,
      metric_label TEXT NOT NULL
    );
  `);
  const retention = db
    .query("SELECT value FROM settings WHERE key = 'retention_days'")
    .get() as { value: string } | undefined;
  if (!retention) {
    db.run("INSERT INTO settings (key, value) VALUES ('retention_days', '30')");
  }
  return db;
}

type SqliteColumn = { name: string };

function addColumnIfMissing(
  database: Database,
  table: string,
  column: string,
  type: string,
): void {
  const cols = database.query(`PRAGMA table_info(${table})`).all() as SqliteColumn[];
  if (!cols.some((col) => col.name === column)) {
    database.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

type SqliteTypedColumn = { name: string; type: string };

/** INTEGER affinity truncates rate `0.5`. Rebuild existing DBs onto REAL. */
function ensureRealThreshold(database: Database): void {
  const cols = database
    .query("PRAGMA table_info(alert_rules)")
    .all() as SqliteTypedColumn[];
  const threshold = cols.find((col) => col.name === "threshold");
  if (!threshold || /REAL|FLOA|DOUB/i.test(threshold.type)) {
    return;
  }
  database.run("BEGIN");
  try {
    database.run(`
      CREATE TABLE alert_rules_p9 (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        query TEXT NOT NULL,
        webhook_url TEXT,
        saved_search_id TEXT,
        threshold REAL NOT NULL DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_fired_at INTEGER,
        last_attempt_at INTEGER,
        last_status TEXT,
        last_error TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        silenced_until INTEGER,
        created_at INTEGER NOT NULL
      );
    `);
    database.run(`
      INSERT INTO alert_rules_p9
        (id, name, query, webhook_url, saved_search_id, threshold, enabled,
         last_fired_at, last_attempt_at, last_status, last_error,
         consecutive_failures, silenced_until, created_at)
      SELECT
        id, name, query, webhook_url, saved_search_id, threshold, COALESCE(enabled, 1),
        last_fired_at, last_attempt_at, last_status, last_error,
        COALESCE(consecutive_failures, 0), silenced_until, created_at
      FROM alert_rules
    `);
    database.run("DROP TABLE alert_rules");
    database.run("ALTER TABLE alert_rules_p9 RENAME TO alert_rules");
    database.run("COMMIT");
  } catch (err) {
    database.run("ROLLBACK");
    throw err;
  }
}

function mkdirp(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function pingSqlite(): boolean {
  const row = getDb().query("SELECT 1 AS ok").get() as { ok: number } | null;
  return row?.ok === 1;
}

export async function getHealth(): Promise<Health> {
  let clickhouse = false;
  let sqlite = false;
  try {
    clickhouse = await pingClickHouse();
  } catch {
    clickhouse = false;
  }
  try {
    sqlite = pingSqlite();
  } catch {
    sqlite = false;
  }
  return {
    ok: clickhouse && sqlite,
    clickhouse,
    sqlite,
  };
}
