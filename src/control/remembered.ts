import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { instanceId } from "./instance";
import { getDb } from "./index";

/**
 * Remembered browsers (frames 34a–34i): after the six digits or a backup code, a person may have
 * this browser skip the code for 1 to 30 days. The password is still asked. Each is a row here,
 * the cookie holds a random token and the row only its hash, so a person or an Owner can forget
 * one, and resetting two-step, a new password or revoking the person forgets them all.
 */

/** The slider's steps, in days; 0 is Off. */
export const rememberSteps = [0, 1, 7, 14, 30] as const;
export type RememberDays = (typeof rememberSteps)[number];
const dayMs = 24 * 60 * 60_000;

export function migrateRemembered(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS remembered_browsers (
      id TEXT PRIMARY KEY,
      person_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      days INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      expires_at INTEGER NOT NULL
    );
  `);
  db.run("CREATE INDEX IF NOT EXISTS remembered_browsers_person ON remembered_browsers (person_id)");
}

export function isRememberDays(value: unknown): value is RememberDays {
  return typeof value === "number" && (rememberSteps as readonly number[]).includes(value);
}

/** The most days an Owner lets a browser be remembered (34h); 30 until they say otherwise. */
export function rememberDaysMax(db: Database = getDb()): RememberDays {
  const row = db.query("SELECT value FROM settings WHERE key = 'remember_days_max'").get() as { value: string } | null;
  const days = row ? Number(row.value) : 30;
  return isRememberDays(days) ? days : 30;
}

/** Lowering the cap shortens browsers already remembered; 0 forgets them all. */
export function writeRememberDaysMax(days: RememberDays, db: Database = getDb()): void {
  db.query("INSERT INTO settings (key, value) VALUES ('remember_days_max', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(days));
  if (days === 0) {
    db.query("DELETE FROM remembered_browsers").run();
    return;
  }
  db.query("UPDATE remembered_browsers SET days = ?, expires_at = created_at + ? WHERE days > ?").run(days, days * dayMs, days);
}

/** One cookie per instance, like the session's: two on one host do not forget each other. */
export function rememberCookieName(): string {
  return `toposcope_remember_${instanceId().replace(/-/g, "").slice(0, 8)}`;
}

export function rememberCookieHeader(value: string, maxAgeSeconds: number, secure: boolean): string {
  return `${rememberCookieName()}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** "Chrome on macOS": enough to tell one's own browsers apart, from the User-Agent. */
export function browserLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "A browser";
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /Windows/.test(ua)
            ? "Windows"
            : /CrOS/.test(ua)
              ? "ChromeOS"
              : /Linux/.test(ua)
                ? "Linux"
                : null;
  return os ? `${browser} on ${os}` : browser;
}

/**
 * Remembers this browser for a person, for `days` within the cap; the token goes in the cookie.
 * A cookie this browser already had for them is replaced, so one browser is one row.
 */
export function rememberBrowser(
  personId: string,
  days: number,
  input: { userAgent?: string; presented?: string },
  now = Date.now(),
  db: Database = getDb(),
): { token: string; expiresAt: number; days: number } | null {
  const want = Math.min(days, rememberDaysMax(db));
  if (!isRememberDays(want) || want === 0) {
    return null;
  }
  if (input.presented) {
    db.query("DELETE FROM remembered_browsers WHERE token_hash = ? AND person_id = ?").run(hash(input.presented), personId);
  }
  const token = randomBytes(32).toString("base64url");
  const expiresAt = now + want * dayMs;
  db.query("INSERT INTO remembered_browsers (id, person_id, token_hash, label, days, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    randomUUID(),
    personId,
    hash(token),
    browserLabel(input.userAgent),
    want,
    now,
    expiresAt,
  );
  db.query("DELETE FROM remembered_browsers WHERE expires_at <= ?").run(now);
  return { token, expiresAt, days: want };
}

/** When this browser's cookie skips the code for this person, its end; else null. */
export function rememberedUntil(personId: string, presented: string | undefined, now = Date.now(), db: Database = getDb()): number | null {
  if (!presented) {
    return null;
  }
  const row = db.query("SELECT id, expires_at FROM remembered_browsers WHERE token_hash = ? AND person_id = ?").get(hash(presented), personId) as
    | { id: string; expires_at: number }
    | null;
  if (!row || row.expires_at <= now) {
    return null;
  }
  db.query("UPDATE remembered_browsers SET last_used_at = ? WHERE id = ?").run(now, row.id);
  return row.expires_at;
}

export type RememberedBrowser = { id: string; label: string; days: number; created_at: number; last_used_at: number | null; expires_at: number; this_browser: boolean };

/** A person's remembered browsers, newest first (34f). */
export function rememberedBrowsersOf(personId: string, presented: string | undefined, now = Date.now(), db: Database = getDb()): RememberedBrowser[] {
  const mine = presented ? hash(presented) : null;
  const rows = db
    .query("SELECT id, token_hash, label, days, created_at, last_used_at, expires_at FROM remembered_browsers WHERE person_id = ? AND expires_at > ? ORDER BY created_at DESC")
    .all(personId, now) as Array<Omit<RememberedBrowser, "this_browser"> & { token_hash: string }>;
  return rows.map(({ token_hash, ...r }) => ({ ...r, this_browser: token_hash === mine }));
}

/** How People says it (34g): how many, and the latest end. */
export function rememberedSummary(personId: string, now = Date.now(), db: Database = getDb()): { count: number; until: number | null } {
  const row = db.query("SELECT COUNT(*) AS n, MAX(expires_at) AS until FROM remembered_browsers WHERE person_id = ? AND expires_at > ?").get(personId, now) as {
    n: number;
    until: number | null;
  };
  return { count: row.n, until: row.until };
}

/** Forgets one of a person's browsers; false when it is not theirs. */
export function forgetBrowser(personId: string, id: string, db: Database = getDb()): boolean {
  return db.query("DELETE FROM remembered_browsers WHERE id = ? AND person_id = ?").run(id, personId).changes > 0;
}

/** Forgets every browser of a person: Forget all, a two-step reset, a new password, revoking them. */
export function forgetBrowsersOf(personId: string, db: Database = getDb()): number {
  return db.query("DELETE FROM remembered_browsers WHERE person_id = ?").run(personId).changes;
}
