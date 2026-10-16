import type { Database } from "bun:sqlite";
import { getDb } from "./index";

/** A name is short enough for a tab title and the header. */
export const maxInstanceNameLength = 64;

function readSetting(key: string, db: Database): string | null {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function writeSetting(key: string, value: string | null, db: Database): void {
  if (value === null) {
    db.query("DELETE FROM settings WHERE key = ?").run(key);
    return;
  }
  db.query(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

/** Made once and kept: what tells this instance from another, behind the password. */
export function instanceId(db: Database = getDb()): string {
  const existing = readSetting("instance_id", db);
  if (existing) {
    return existing;
  }
  const id = crypto.randomUUID();
  db.query("INSERT OR IGNORE INTO settings (key, value) VALUES ('instance_id', ?)").run(id);
  return readSetting("instance_id", db) ?? id;
}

/** The name the operator set in Settings, or null while it has none. */
export function instanceName(db: Database = getDb()): string | null {
  const name = readSetting("instance_name", db);
  return name && name.trim() ? name : null;
}

/** Trimmed; empty unsets it. A name is printable text, at most 64 characters. */
export function parseInstanceName(value: unknown): string | null | { error: string } {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return { error: "instance_name must be text" };
  }
  const name = value.trim().replace(/\s+/g, " ");
  if (!name) {
    return null;
  }
  if (name.length > maxInstanceNameLength) {
    return { error: `The instance name is at most ${maxInstanceNameLength} characters` };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    return { error: "The instance name cannot hold control characters" };
  }
  return name;
}

export function writeInstanceName(name: string | null, db: Database = getDb()): string | null {
  writeSetting("instance_name", name, db);
  return instanceName(db);
}
