import { AsyncLocalStorage } from "node:async_hooks";
import type { Database } from "bun:sqlite";
import { getDb } from "./index";

/**
 * Who made a write (#307). The middleware runs each request with its actor here; a write stamps
 * `created_by` / `updated_by` from it. A person or service account is its id; an ingest token is
 * `token:<name>`; Toposcope itself (a monitor's own pass) is null.
 */
const store = new AsyncLocalStorage<string | null>();

export function runAs<T>(ref: string | null, fn: () => T): T {
  return store.run(ref, fn);
}

export function currentActorRef(): string | null {
  return store.getStore() ?? null;
}

/** Tables whose rows carry who made and last changed them. */
export const actorTables = ["saved_searches", "alert_rules", "shares", "links", "link_keys", "api_tokens"] as const;
type ActorTable = (typeof actorTables)[number];

export function migrateActors(db: Database, addColumn: (db: Database, table: string, column: string, type: string) => void): void {
  for (const table of actorTables) {
    addColumn(db, table, "created_by", "TEXT");
    addColumn(db, table, "updated_by", "TEXT");
  }
}

const keyColumn: Record<ActorTable, string> = {
  saved_searches: "id",
  alert_rules: "id",
  shares: "id",
  links: "id",
  link_keys: "kid",
  api_tokens: "id",
};

/** A row just made: made and changed by whoever is acting. */
export function stampCreated(table: ActorTable, key: string, db: Database = getDb()): void {
  const ref = currentActorRef();
  db.query(`UPDATE ${table} SET created_by = ?, updated_by = ? WHERE ${keyColumn[table]} = ?`).run(ref, ref, key);
}

/** A row just changed: changed by whoever is acting (Toposcope's own passes leave it). */
export function stampUpdated(table: ActorTable, key: string, db: Database = getDb()): void {
  const ref = currentActorRef();
  if (ref === null) {
    return;
  }
  db.query(`UPDATE ${table} SET updated_by = ? WHERE ${keyColumn[table]} = ?`).run(ref, key);
}

/** A setting just changed (retention, the webhook, the name, Fields): who and when. */
export function stampSetting(key: string, now = Date.now(), db: Database = getDb()): void {
  const ref = currentActorRef();
  db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    `by:${key}`,
    JSON.stringify({ by: ref, at: now }),
  );
}

export function settingStamp(key: string, db: Database = getDb()): { by: ActorName | null; at: number } | null {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(`by:${key}`) as { value: string } | null;
  if (!row) {
    return null;
  }
  try {
    const parsed = JSON.parse(row.value) as { by: string | null; at: number };
    return { by: actorName(parsed.by, db), at: parsed.at };
  } catch {
    return null;
  }
}

/** `agent` is true for an agent's service account (#357): the UI wears its badge. */
export type ActorName = { id: string; name: string; revoked: boolean; kind: "person" | "service" | "token"; agent: boolean };

/** A stamp as the UI shows it: "Maya K.", a service account's name, or a token's. */
export function actorName(ref: string | null | undefined, db: Database = getDb()): ActorName | null {
  if (!ref) {
    return null;
  }
  if (ref.startsWith("token:")) {
    return { id: ref, name: ref.slice("token:".length), revoked: false, kind: "token", agent: false };
  }
  const row = db.query("SELECT id, kind, name, revoked_at, agent FROM people WHERE id = ?").get(ref) as
    | { id: string; kind: "person" | "service"; name: string; revoked_at: number | null; agent: number }
    | null;
  return row ? { id: row.id, name: row.name, revoked: row.revoked_at !== null, kind: row.kind, agent: row.agent === 1 } : null;
}

/** Rows made before 0.9 pass to the first Owner (#307). */
export function adoptUnstamped(personId: string, db: Database = getDb()): void {
  for (const table of actorTables) {
    db.query(`UPDATE ${table} SET created_by = ? WHERE created_by IS NULL`).run(personId);
  }
}
