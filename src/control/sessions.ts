import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";
import { getDb } from "./index";

/** A sign-in lasts 30 days on that browser, until Sign out or a new password. */
export const sessionMs = 30 * 24 * 60 * 60_000;

function sessionKey(password: string): Buffer {
  return createHash("sha256").update(`toposcope-session\0${password}`).digest();
}

function sign(id: string, password: string): string {
  return createHmac("sha256", sessionKey(password)).update(id).digest("base64url");
}

/**
 * A new session: a random id kept in SQLite with its end, signed with a key made from the
 * password, so changing the password ends every session at once.
 */
export function createSession(
  password: string,
  now = Date.now(),
  db: Database = getDb(),
): { value: string; expiresAt: number } {
  const id = randomBytes(24).toString("base64url");
  const expiresAt = now + sessionMs;
  db.query("INSERT INTO sessions (id, expires_at, created_at) VALUES (?, ?, ?)").run(id, expiresAt, now);
  db.query("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  return { value: `${id}.${sign(id, password)}`, expiresAt };
}

/** The session's end, or null when the cookie is not a live session for this password. */
export function sessionExpiry(
  value: string | undefined,
  password: string | undefined,
  now = Date.now(),
  db: Database = getDb(),
): number | null {
  if (!value || !password) {
    return null;
  }
  const dot = value.indexOf(".");
  if (dot <= 0) {
    return null;
  }
  const id = value.slice(0, dot);
  const presented = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(sign(id, password));
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return null;
  }
  const row = db.query("SELECT expires_at FROM sessions WHERE id = ?").get(id) as
    | { expires_at: number }
    | undefined;
  return row && row.expires_at > now ? row.expires_at : null;
}

export function endSession(value: string | undefined, db: Database = getDb()): void {
  if (!value) {
    return;
  }
  const dot = value.indexOf(".");
  if (dot > 0) {
    db.query("DELETE FROM sessions WHERE id = ?").run(value.slice(0, dot));
  }
}
