import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";
import { getDb } from "./index";
import type { Person } from "./people";
import { forgetBrowsersOf } from "./remembered";

/**
 * Two-step sign-in (#309, frames 32b–32e): a TOTP authenticator app (RFC 6238: SHA-1, 30 s,
 * 6 digits) and ten single-use backup codes, for every local password. Required for everyone
 * with a password, or for Owners only, as Settings says.
 */

export type TwoStepFor = "everyone" | "owners";

export function migrateTwoStep(db: Database, addColumn: (db: Database, table: string, column: string, type: string) => void): void {
  addColumn(db, "people", "totp_secret", "TEXT");
  addColumn(db, "people", "totp_pending", "TEXT");
  addColumn(db, "people", "totp_last_step", "INTEGER");
  addColumn(db, "people", "backup_codes", "TEXT");
  addColumn(db, "people", "two_step_reset_by", "TEXT");
  addColumn(db, "people", "two_step_reset_at", "INTEGER");
  // A session's stage: full, or waiting on the second step ("verify") or on setting it up ("setup", "codes").
  addColumn(db, "sessions", "stage", "TEXT NOT NULL DEFAULT 'full'");
  addColumn(db, "sessions", "next", "TEXT");
}

export function twoStepFor(db: Database = getDb()): TwoStepFor {
  const row = db.query("SELECT value FROM settings WHERE key = 'two_step_for'").get() as { value: string } | null;
  return row?.value === "owners" ? "owners" : "everyone";
}

export function writeTwoStepFor(value: TwoStepFor, db: Database = getDb()): void {
  db.query("INSERT INTO settings (key, value) VALUES ('two_step_for', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(value);
}

/** Whether this person must have a second step before they can use the app. */
export function twoStepRequired(person: Pick<Person, "role" | "kind" | "password_hash">, db: Database = getDb()): boolean {
  if (person.kind !== "person" || !person.password_hash) {
    return false;
  }
  return twoStepFor(db) === "everyone" || person.role === "owner";
}

// ---- Secrets at rest ----

function key(db: Database): Buffer {
  const row = db.query("SELECT value FROM settings WHERE key = 'session_secret'").get() as { value: string } | null;
  const secret = process.env.TOPOSCOPE_SESSION_SECRET && process.env.TOPOSCOPE_SESSION_SECRET.length >= 32 ? process.env.TOPOSCOPE_SESSION_SECRET : (row?.value ?? "");
  return createHash("sha256").update(`toposcope-two-step\0${secret}`).digest();
}

function seal(plain: string, db: Database): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(db), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
}

function open(sealed: string, db: Database): string | null {
  try {
    const [iv, tag, body] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", key(db), iv!);
    decipher.setAuthTag(tag!);
    return Buffer.concat([decipher.update(body!), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** For tests only: the kept secret, to make the code an app would show. */
export function openSecretForTests(sealed: string, db: Database = getDb()): string {
  return open(sealed, db) ?? "";
}

// ---- TOTP ----

const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += base32Alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += base32Alphabet[(value << (5 - bits)) & 31];
  }
  return out;
}

function fromBase32(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text.replace(/[\s=]/g, "").toUpperCase()) {
    const i = base32Alphabet.indexOf(ch);
    if (i < 0) {
      continue;
    }
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The six digits for a step (RFC 4226 HOTP over the 30 s step). */
export function totpAt(secretBase32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", fromBase32(secretBase32)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const code = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(code % 1_000_000).padStart(6, "0");
}

export function stepOf(nowMs: number): number {
  return Math.floor(nowMs / 30_000);
}

/** The step a code matches, one step either side for a clock off by up to 30 s, or null. */
export function matchTotp(secretBase32: string, code: string, nowMs: number): number | null {
  const digits = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(digits)) {
    return null;
  }
  const now = stepOf(nowMs);
  for (const step of [now, now - 1, now + 1]) {
    const want = Buffer.from(totpAt(secretBase32, step));
    if (timingSafeEqual(want, Buffer.from(digits))) {
      return step;
    }
  }
  return null;
}

/** "JBSW Y3DP EHPK 3PXP 4Q2A …": the key as 32b writes it, in groups of four. */
export function groupedKey(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

export function otpauthUri(secret: string, account: string, instance: string): string {
  const label = encodeURIComponent(`Toposcope (${instance}):${account}`);
  const issuer = encodeURIComponent(`Toposcope (${instance})`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}

/** A new secret, kept sealed and pending until a code from it is right (32b). */
export function beginSetup(personId: string, db: Database = getDb()): string {
  const row = db.query("SELECT totp_pending FROM people WHERE id = ?").get(personId) as { totp_pending: string | null } | null;
  const kept = row?.totp_pending ? open(row.totp_pending, db) : null;
  if (kept) {
    return kept;
  }
  const secret = base32(randomBytes(20));
  db.query("UPDATE people SET totp_pending = ? WHERE id = ?").run(seal(secret, db), personId);
  return secret;
}

// ---- Backup codes ----

const codeAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function newCode(): string {
  const raw = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += codeAlphabet[raw[i]! % codeAlphabet.length];
    if (i === 3) {
      out += "-";
    }
  }
  return out;
}

function hashCode(code: string): string {
  return createHash("sha256").update(code.replace(/[\s-]/g, "").toUpperCase()).digest("hex");
}

type StoredCodes = Array<{ h: string; used: number | null }>;

/** Ten new codes, shown once (32c); any earlier ones stop working. */
export function makeBackupCodes(personId: string, db: Database = getDb()): string[] {
  const codes = Array.from({ length: 10 }, newCode);
  const stored: StoredCodes = codes.map((c) => ({ h: hashCode(c), used: null }));
  db.query("UPDATE people SET backup_codes = ? WHERE id = ?").run(JSON.stringify(stored), personId);
  return codes;
}

export function backupCodesLeft(raw: string | null): number {
  if (!raw) {
    return 0;
  }
  try {
    return (JSON.parse(raw) as StoredCodes).filter((c) => c.used === null).length;
  } catch {
    return 0;
  }
}

/** Confirms setup with a first code from the app: the secret is kept, ten codes are made. */
export function confirmSetup(personId: string, code: string, nowMs = Date.now(), db: Database = getDb()): string[] | null {
  const row = db.query("SELECT totp_pending FROM people WHERE id = ?").get(personId) as { totp_pending: string | null } | null;
  const secret = row?.totp_pending ? open(row.totp_pending, db) : null;
  if (!secret) {
    return null;
  }
  const step = matchTotp(secret, code, nowMs);
  if (step === null) {
    return null;
  }
  db.query(
    "UPDATE people SET totp_secret = totp_pending, totp_pending = NULL, totp_last_step = ?, two_step_reset_by = NULL, two_step_reset_at = NULL WHERE id = ?",
  ).run(step, personId);
  return makeBackupCodes(personId, db);
}

export type SecondStep = { ok: true; via: "app" } | { ok: true; via: "backup"; left: number } | { ok: false };

/** Checks a code from the app, or a backup code; a code is never accepted twice. */
export function checkSecondStep(personId: string, input: { code?: string; backup?: string }, nowMs = Date.now(), db: Database = getDb()): SecondStep {
  const row = db.query("SELECT totp_secret, totp_last_step, backup_codes FROM people WHERE id = ?").get(personId) as
    | { totp_secret: string | null; totp_last_step: number | null; backup_codes: string | null }
    | null;
  if (!row?.totp_secret) {
    return { ok: false };
  }
  if (input.code) {
    const secret = open(row.totp_secret, db);
    const step = secret ? matchTotp(secret, input.code, nowMs) : null;
    if (step === null || (row.totp_last_step !== null && step <= row.totp_last_step)) {
      return { ok: false };
    }
    db.query("UPDATE people SET totp_last_step = ? WHERE id = ?").run(step, personId);
    return { ok: true, via: "app" };
  }
  if (input.backup && row.backup_codes) {
    const stored = JSON.parse(row.backup_codes) as StoredCodes;
    const want = hashCode(input.backup);
    const hit = stored.find((c) => c.used === null && c.h === want);
    if (!hit) {
      return { ok: false };
    }
    hit.used = nowMs;
    db.query("UPDATE people SET backup_codes = ? WHERE id = ?").run(JSON.stringify(stored), personId);
    return { ok: true, via: "backup", left: stored.filter((c) => c.used === null).length };
  }
  return { ok: false };
}

export function hasTwoStep(personId: string, db: Database = getDb()): boolean {
  const row = db.query("SELECT totp_secret FROM people WHERE id = ?").get(personId) as { totp_secret: string | null } | null;
  return Boolean(row?.totp_secret);
}

/** An Owner's reset for a lost phone and lost codes (32e): set up again at the next sign-in. */
export function resetTwoStep(personId: string, by: string | null, nowMs = Date.now(), db: Database = getDb()): void {
  db.query(
    "UPDATE people SET totp_secret = NULL, totp_pending = NULL, totp_last_step = NULL, backup_codes = NULL, two_step_reset_by = ?, two_step_reset_at = ?, session_epoch = session_epoch + 1 WHERE id = ?",
  ).run(by, nowMs, personId);
  db.query("DELETE FROM sessions WHERE person_id = ?").run(personId);
  forgetBrowsersOf(personId, db);
}

/** What People says about a person's second step (32e). */
export function twoStepState(person: Person, db: Database = getDb()): { state: "on" | "not set up" | "reset" | "provider" | "none"; codes_left: number; reset_by: string | null; reset_at: number | null } {
  const row = db.query("SELECT totp_secret, backup_codes, two_step_reset_by, two_step_reset_at FROM people WHERE id = ?").get(person.id) as {
    totp_secret: string | null;
    backup_codes: string | null;
    two_step_reset_by: string | null;
    two_step_reset_at: number | null;
  };
  if (person.kind === "service") {
    return { state: "none", codes_left: 0, reset_by: null, reset_at: null };
  }
  if (!person.password_hash) {
    return { state: "provider", codes_left: 0, reset_by: null, reset_at: null };
  }
  if (row.totp_secret) {
    return { state: "on", codes_left: backupCodesLeft(row.backup_codes), reset_by: null, reset_at: null };
  }
  return { state: row.two_step_reset_at ? "reset" : "not set up", codes_left: 0, reset_by: row.two_step_reset_by, reset_at: row.two_step_reset_at };
}
