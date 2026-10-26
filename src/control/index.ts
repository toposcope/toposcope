import { mkdirSync } from "node:fs";
import { Database } from "bun:sqlite";
import { pingClickHouse } from "../shared/clickhouse";
import { defaultSqlitePath } from "../shared/sqlite-path";
import {
  healthFromPings,
  type BootPhase,
  type Health,
} from "../shared/boot";

export type { Health };

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
  migrateControlDb(db);
  return db;
}

/** The control plane's tables, created or brought up to date in place. */
export function migrateControlDb(db: Database): void {
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
  // Home's Pinned column (#259): a saved search or board the operator keeps at hand.
  addColumnIfMissing(db, "saved_searches", "pinned", "INTEGER NOT NULL DEFAULT 0");
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
  // After the threshold rebuild, which copies only the columns it knows.
  addColumnIfMissing(db, "alert_rules", "kind", "TEXT NOT NULL DEFAULT 'threshold'");
  addColumnIfMissing(db, "alert_rules", "last_mark", "TEXT");
  addColumnIfMissing(db, "alert_rules", "body_kind", "TEXT NOT NULL DEFAULT 'default'");
  addColumnIfMissing(db, "alert_rules", "body_template", "TEXT");
  // A monitor (#175): where its results come from, ok or open, how often it reminds, and its
  // resolved body. Rules that exist at the upgrade remind every window, as they called before.
  addColumnIfMissing(db, "alert_rules", "source", "TEXT");
  db.run(
    "UPDATE alert_rules SET source = CASE kind WHEN 'first_seen' THEN 'fingerprints' ELSE 'search' END WHERE source IS NULL",
  );
  addColumnIfMissing(db, "alert_rules", "state", "TEXT NOT NULL DEFAULT 'ok'");
  addColumnIfMissing(db, "alert_rules", "remind_every", "TEXT NOT NULL DEFAULT 'window'");
  addColumnIfMissing(db, "alert_rules", "resolved_body", "TEXT");
  addColumnIfMissing(db, "alert_rules", "last_result", "TEXT");
  addColumnIfMissing(db, "alert_rules", "last_value", "REAL");
  addColumnIfMissing(db, "alert_rules", "last_result_at", "INTEGER");
  // A search monitor opens at least or fewer than its threshold, and says why it could not tell (#176).
  addColumnIfMissing(db, "alert_rules", "opens_when", "TEXT NOT NULL DEFAULT 'at_least'");
  // #279: a monitor compares its series, or its search's share of all rows.
  addColumnIfMissing(db, "alert_rules", "measure", "TEXT NOT NULL DEFAULT 'series'");
  // #280: every delivery target, as JSON; null keeps the one webhook_url.
  addColumnIfMissing(db, "alert_rules", "webhook_urls", "TEXT");
  addColumnIfMissing(db, "alert_rules", "cant_tell", "TEXT");
  // A push monitor (#177): its keyed URL, when its next result is due and how long past that it
  // waits, when its due time counts from, the run started and not yet ended, its last ok, and
  // when it was paused (any monitor).
  addColumnIfMissing(db, "alert_rules", "ping_key", "TEXT");
  addColumnIfMissing(db, "alert_rules", "every_ms", "INTEGER");
  addColumnIfMissing(db, "alert_rules", "grace_ms", "INTEGER");
  addColumnIfMissing(db, "alert_rules", "due_from", "INTEGER");
  addColumnIfMissing(db, "alert_rules", "started_at", "INTEGER");
  addColumnIfMissing(db, "alert_rules", "last_ok_at", "INTEGER");
  addColumnIfMissing(db, "alert_rules", "paused_at", "INTEGER");
  db.run("CREATE UNIQUE INDEX IF NOT EXISTS alert_rules_ping_key ON alert_rules (ping_key) WHERE ping_key IS NOT NULL");
  // A monitor's results for Watch's ticks (#177, #178), shared by the sources that have results: one row
  // a monitor a minute, the worst of the minute winning (fail > warn > ok, of equals the later), for
  // 30 days. Each result is also a log row. Exit code, unit, host and via are push's, for 18f / 18s.
  db.run(`
    CREATE TABLE IF NOT EXISTS monitor_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id TEXT NOT NULL,
      minute INTEGER NOT NULL,
      at INTEGER NOT NULL,
      result TEXT NOT NULL,
      exit_code INTEGER,
      duration_ms INTEGER,
      value REAL,
      unit TEXT,
      message TEXT NOT NULL DEFAULT '',
      host TEXT NOT NULL DEFAULT '',
      via TEXT NOT NULL DEFAULT '',
      UNIQUE (monitor_id, minute)
    );
  `);
  db.run("CREATE INDEX IF NOT EXISTS monitor_results_by_monitor ON monitor_results (monitor_id, at)");
  db.run("CREATE INDEX IF NOT EXISTS monitor_results_by_at ON monitor_results (at)");
  // Each open-to-resolved stretch, and the calls sent for it (#175).
  db.run(`
    CREATE TABLE IF NOT EXISTS monitor_stretches (
      id TEXT PRIMARY KEY,
      monitor_id TEXT NOT NULL,
      opened_at INTEGER NOT NULL,
      resolved_at INTEGER,
      closed_by TEXT,
      open_value REAL,
      open_count REAL,
      open_message TEXT NOT NULL DEFAULT '',
      last_value REAL,
      last_count REAL,
      last_at INTEGER NOT NULL,
      called_at INTEGER,
      open_call TEXT,
      resolved_call TEXT
    );
  `);
  db.run(
    "CREATE INDEX IF NOT EXISTS monitor_stretches_by_monitor ON monitor_stretches (monitor_id, opened_at)",
  );
  // When the result a push monitor missed was due (#177): Watch draws it late from there.
  addColumnIfMissing(db, "monitor_stretches", "due_at", "INTEGER");
  db.run(`
    CREATE TABLE IF NOT EXISTS monitor_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id TEXT NOT NULL,
      stretch_id TEXT,
      at INTEGER NOT NULL,
      what TEXT NOT NULL,
      status TEXT NOT NULL,
      ok INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );
  `);
  db.run("CREATE INDEX IF NOT EXISTS monitor_calls_by_monitor ON monitor_calls (monitor_id, at)");
  // What an HTTP(S) monitor calls, its conditions, and where its runs stand (#178).
  db.run(`
    CREATE TABLE IF NOT EXISTS monitor_http (
      monitor_id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT 'GET',
      body TEXT,
      headers TEXT NOT NULL DEFAULT '[]',
      every_ms INTEGER NOT NULL DEFAULT 30000,
      conditions TEXT NOT NULL DEFAULT '',
      fail_after INTEGER NOT NULL DEFAULT 2,
      fails_in_row INTEGER NOT NULL DEFAULT 0,
      next_run_at INTEGER,
      last_run TEXT
    );
  `);
  // Where a TCP or certificate monitor connects, its conditions, and where its runs stand (#180).
  db.run(`
    CREATE TABLE IF NOT EXISTS monitor_net (
      monitor_id TEXT PRIMARY KEY,
      target TEXT NOT NULL,
      starttls TEXT,
      every_ms INTEGER NOT NULL DEFAULT 30000,
      conditions TEXT NOT NULL DEFAULT '',
      fail_after INTEGER NOT NULL DEFAULT 2,
      fails_in_row INTEGER NOT NULL DEFAULT 0,
      next_run_at INTEGER,
      last_run TEXT
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS alert_sent_fingerprints (
      rule_id TEXT NOT NULL,
      mark_id TEXT NOT NULL,
      e1 TEXT NOT NULL,
      sent_at INTEGER NOT NULL,
      PRIMARY KEY (rule_id, mark_id, e1)
    );
  `);
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
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS field_roles (
      key TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK (role IN ('chart', 'lookup', 'ignore'))
    );
  `);
  // Link keys this instance minted, and links (#136): see src/links/store.ts.
  db.run(`
    CREATE TABLE IF NOT EXISTS link_keys (
      kid TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('offer', 'invite')),
      q TEXT NOT NULL,
      secret_hash TEXT NOT NULL,
      until INTEGER,
      uses INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      spent_at INTEGER,
      revoked_at INTEGER
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS links (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK (role IN ('pull', 'serve')),
      connects TEXT NOT NULL CHECK (connects IN ('we', 'they')),
      peer_id TEXT NOT NULL,
      peer_name TEXT NOT NULL,
      peer_url TEXT NOT NULL DEFAULT '',
      q TEXT NOT NULL,
      kid TEXT NOT NULL,
      secret TEXT,
      secret_hash TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      settled INTEGER NOT NULL DEFAULT 0,
      arrived_at TEXT,
      behind_rows INTEGER,
      gone_from INTEGER,
      gone_to INTEGER,
      last_contact_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      removed_at INTEGER
    );
  `);
  // A hole's ends in time (#139): where reading stopped, and the start of the oldest day the source kept.
  addColumnIfMissing(db, "links", "gone_from_at", "TEXT");
  addColumnIfMissing(db, "links", "gone_to_at", "TEXT");
  // A feed (#135): rows by arrival through one q, fixed when it is defined.
  db.run(`
    CREATE TABLE IF NOT EXISTS feeds (
      id TEXT PRIMARY KEY,
      q TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS field_links (
      log_key TEXT PRIMARY KEY,
      metric_label TEXT NOT NULL
    );
  `);
  // Shares (#225): a scope of data and the hash of its secret; see src/share/store.ts.
  db.run(`
    CREATE TABLE IF NOT EXISTS shares (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      scope TEXT NOT NULL,
      secret_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  // A share's limits (#226), as JSON: finest bar, longest window, oldest reach, reads per minute.
  addColumnIfMissing(db, "shares", "limits", "TEXT NOT NULL DEFAULT '{}'");
  // Who may frame a share's panels, and how long its tickets last (#227), as JSON.
  addColumnIfMissing(db, "shares", "embed", "TEXT NOT NULL DEFAULT '{}'");
  const retention = db
    .query("SELECT value FROM settings WHERE key = 'retention_days'")
    .get() as { value: string } | undefined;
  if (!retention) {
    db.run("INSERT INTO settings (key, value) VALUES ('retention_days', '30')");
  }
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

export async function getHealth(phase: BootPhase): Promise<Health> {
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
  return healthFromPings(phase, { clickhouse, sqlite }).body;
}
