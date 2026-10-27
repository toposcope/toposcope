import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";
import { getDb } from "./index";
import { adoptUnstamped } from "./actors";

/**
 * People (#305, frames 30a–30e, 32a): who signs in, and the tokens that act for them. There is no
 * shared password: the first Owner comes from a one-time link a host command prints, a browser
 * signs in as a person, and a script sends a person's or a service account's token.
 */

export type Role = "viewer" | "operator" | "owner";
export const roles: readonly Role[] = ["viewer", "operator", "owner"];
export type PersonKind = "person" | "service";

export type Person = {
  id: string;
  kind: PersonKind;
  name: string;
  email: string | null;
  role: Role;
  password_hash: string | null;
  session_epoch: number;
  created_at: number;
  created_by: string | null;
  last_seen_at: number | null;
  revoked_at: number | null;
};

/** Who a request is: a person or service account, and the token it came with, if any. */
export type Actor = {
  person: Person;
  via: "session" | "token";
  token: { id: string; name: string; read_only: boolean } | null;
  /** The role this request acts with: a read-only token acts as a Viewer. */
  role: Role;
};

/** A sign-in lasts 30 days on that browser, sliding, until Sign out, revoke or a new password. */
export const sessionMs = 30 * 24 * 60 * 60_000;
/** An owner link works once, for an hour (32a). */
export const ownerLinkMs = 60 * 60_000;
export const minPasswordLength = 12;
const tokenPrefix = "tsp1_";
const ownerLinkPrefix = "tsu1_";

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (roles as readonly string[]).includes(value);
}

/** Owner > Operator > Viewer. */
export function roleAtLeast(role: Role, need: Role): boolean {
  return roles.indexOf(role) >= roles.indexOf(need);
}

export function migratePeople(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS people (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'person',
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      role TEXT NOT NULL,
      password_hash TEXT,
      session_epoch INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      created_by TEXT,
      last_seen_at INTEGER,
      revoked_at INTEGER
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS person_tokens (
      id TEXT PRIMARY KEY,
      person_id TEXT NOT NULL,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      read_only INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      created_by TEXT,
      expires_at INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at INTEGER
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS invites (
      id TEXT PRIMARY KEY,
      who TEXT NOT NULL,
      role TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      created_by TEXT,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      used_by TEXT,
      cancelled_at INTEGER
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS owner_links (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
  `);
  // 0.8 sessions were signed with a key made from the shared password and belong to nobody.
  // 0.9 sessions belong to a person; the old table is replaced, so every 0.8 browser signs in again.
  const cols = db.query("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  if (cols.length > 0 && !cols.some((c) => c.name === "person_id")) {
    db.run("DROP TABLE sessions");
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      person_id TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
  `);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The key sessions are signed with: `TOPOSCOPE_SESSION_SECRET`, or one made once and kept in SQLite. */
function sessionSecret(db: Database): string {
  const env = process.env.TOPOSCOPE_SESSION_SECRET;
  if (env && env.length >= 32) {
    return env;
  }
  const row = db.query("SELECT value FROM settings WHERE key = 'session_secret'").get() as { value: string } | null;
  if (row?.value) {
    return row.value;
  }
  const made = randomBytes(32).toString("hex");
  db.query("INSERT OR IGNORE INTO settings (key, value) VALUES ('session_secret', ?)").run(made);
  const kept = db.query("SELECT value FROM settings WHERE key = 'session_secret'").get() as { value: string };
  return kept.value;
}

export function normalEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function looksLikeEmail(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim());
}

export function passwordProblem(password: string): string | null {
  return password.length < minPasswordLength ? `A password is ${minPasswordLength} characters or more` : null;
}

export function personById(id: string, db: Database = getDb()): Person | null {
  return (db.query("SELECT * FROM people WHERE id = ?").get(id) as Person | null) ?? null;
}

export function personByEmail(email: string, db: Database = getDb()): Person | null {
  return (db.query("SELECT * FROM people WHERE email = ?").get(normalEmail(email)) as Person | null) ?? null;
}

export function allPeople(db: Database = getDb()): Person[] {
  return db.query("SELECT * FROM people ORDER BY created_at").all() as Person[];
}

/** Owners who can still sign in. */
export function liveOwnerCount(db: Database = getDb()): number {
  const row = db
    .query("SELECT count(*) AS n FROM people WHERE role = 'owner' AND kind = 'person' AND revoked_at IS NULL")
    .get() as { n: number };
  return row.n;
}

export function firstOwner(db: Database = getDb()): Person | null {
  return (
    (db
      .query("SELECT * FROM people WHERE role = 'owner' AND kind = 'person' ORDER BY created_at LIMIT 1")
      .get() as Person | null) ?? null
  );
}

// ---- Owner links (32a): a host command prints one; it makes the first Owner or resets one ----

/** A one-time link for `email`, valid an hour. The token is shown once and kept hashed. */
export function createOwnerLink(email: string, now = Date.now(), db: Database = getDb()): { token: string; expires_at: number; makes: boolean } {
  const address = normalEmail(email);
  if (!looksLikeEmail(address)) {
    throw new Error("owner-link needs an email address");
  }
  const existing = personByEmail(address, db);
  if (existing && (existing.kind !== "person" || existing.role !== "owner")) {
    throw new Error(`${address} is not an Owner here; an Owner changes their role in Access`);
  }
  const token = `${ownerLinkPrefix}${randomBytes(24).toString("base64url")}`;
  const expiresAt = now + ownerLinkMs;
  db.query("INSERT INTO owner_links (id, token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").run(
    randomUUID(),
    hash(token),
    address,
    now,
    expiresAt,
  );
  return { token, expires_at: expiresAt, makes: existing === null };
}

export type OwnerLink = { id: string; email: string; expires_at: number; person: Person | null };

/** The link a token opens, while it is unused and inside its hour. */
export function ownerLinkFor(token: string, now = Date.now(), db: Database = getDb()): OwnerLink | null {
  if (!token.startsWith(ownerLinkPrefix)) {
    return null;
  }
  const row = db.query("SELECT id, email, expires_at, used_at FROM owner_links WHERE token_hash = ?").get(hash(token)) as
    | { id: string; email: string; expires_at: number; used_at: number | null }
    | null;
  if (!row || row.used_at !== null || row.expires_at <= now) {
    return null;
  }
  return { id: row.id, email: row.email, expires_at: row.expires_at, person: personByEmail(row.email, db) };
}

/**
 * Uses an owner link: makes the Owner it names (the first Owner, on a new instance) or gives an
 * existing Owner a new password and ends their sessions.
 */
export async function useOwnerLink(
  token: string,
  input: { name: string; password: string },
  now = Date.now(),
  db: Database = getDb(),
): Promise<{ person: Person } | { error: string }> {
  const link = ownerLinkFor(token, now, db);
  if (!link) {
    return { error: "This link has been used or is more than an hour old. Run owner-link on the host again." };
  }
  const problem = passwordProblem(input.password);
  if (problem) {
    return { error: problem };
  }
  const passwordHash = await Bun.password.hash(input.password, { algorithm: "argon2id" });
  db.query("UPDATE owner_links SET used_at = ? WHERE id = ?").run(now, link.id);
  if (link.person) {
    // The way back in for a locked-out Owner: a new password and a new second step (32g).
    db.query(
      "UPDATE people SET password_hash = ?, session_epoch = session_epoch + 1, revoked_at = NULL, totp_secret = NULL, totp_pending = NULL, totp_last_step = NULL, backup_codes = NULL WHERE id = ?",
    ).run(passwordHash, link.person.id);
    return { person: personById(link.person.id, db)! };
  }
  const name = input.name.trim() || link.email.split("@")[0]!;
  const id = randomUUID();
  const first = firstOwner(db) === null;
  db.query(
    "INSERT INTO people (id, kind, name, email, role, password_hash, created_at, created_by) VALUES (?, 'person', ?, ?, 'owner', ?, ?, 'owner-link')",
  ).run(id, name, link.email, passwordHash, now);
  if (first) {
    adoptUnowned(id, db);
    adoptUnstamped(id, db);
  }
  return { person: personById(id, db)! };
}

/**
 * Everything made before 0.9 passes to the first Owner (#306, #307): saved hunts (still shared)
 * and the pins Home had, which become theirs.
 */
export function adoptUnowned(personId: string, db: Database = getDb()): void {
  db.query("INSERT OR IGNORE INTO person_pins (person_id, saved_id) SELECT ?, id FROM saved_searches WHERE pinned = 1 AND owner_id IS NULL").run(personId);
  db.query("UPDATE saved_searches SET owner_id = ? WHERE owner_id IS NULL").run(personId);
}

// ---- Passwords: slow down, never lock ----

const failures = new Map<string, number[]>();
const failWindowMs = 15 * 60_000;

/** How long the next try for this email must wait: none for the first five misses in 15 minutes. */
export function signInWaitMs(email: string, now = Date.now()): number {
  const recent = (failures.get(normalEmail(email)) ?? []).filter((t) => now - t < failWindowMs);
  if (recent.length < 5) {
    return 0;
  }
  const wait = Math.min(30_000, 1000 * 2 ** (recent.length - 5));
  const since = now - recent[recent.length - 1]!;
  return Math.max(0, wait - since);
}

export function noteSignInFailure(email: string, now = Date.now()): void {
  const key = normalEmail(email);
  const recent = (failures.get(key) ?? []).filter((t) => now - t < failWindowMs);
  recent.push(now);
  failures.set(key, recent);
}

export function clearSignInFailures(email: string): void {
  failures.delete(normalEmail(email));
}

let dummyHash: Promise<string> | undefined;

/** The person an email and password sign in, or null. */
export async function checkPassword(email: string, password: string, db: Database = getDb()): Promise<Person | null> {
  const person = personByEmail(email, db);
  if (!person || person.kind !== "person" || person.revoked_at !== null || !person.password_hash) {
    // Spend the same time as a real check, so a wrong email is not told apart.
    dummyHash ??= Bun.password.hash("not a password anyone has", { algorithm: "argon2id" });
    await Bun.password.verify(password, await dummyHash);
    return null;
  }
  return (await Bun.password.verify(password, person.password_hash)) ? person : null;
}

export async function setPassword(personId: string, password: string, db: Database = getDb()): Promise<string | null> {
  const problem = passwordProblem(password);
  if (problem) {
    return problem;
  }
  const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id" });
  db.query("UPDATE people SET password_hash = ?, session_epoch = session_epoch + 1 WHERE id = ?").run(passwordHash, personId);
  return null;
}

// ---- Sessions ----

export type SessionStage = "full" | "verify" | "setup" | "codes";
/** A password alone opens only the second step, or its setup, for 15 minutes (#309). */
export const pendingMs = 15 * 60_000;

export function createSession(
  person: Person,
  now = Date.now(),
  db: Database = getDb(),
  stage: SessionStage = "full",
  next: string | null = null,
): { value: string; expiresAt: number } {
  const id = randomBytes(24).toString("base64url");
  const expiresAt = now + (stage === "full" ? sessionMs : pendingMs);
  db.query("INSERT INTO sessions (id, person_id, epoch, created_at, expires_at, last_seen_at, stage, next) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    id,
    person.id,
    person.session_epoch,
    now,
    expiresAt,
    now,
    stage,
    next,
  );
  db.query("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  return { value: `${id}.${sign(id, db)}`, expiresAt };
}

function sign(id: string, db: Database): string {
  return createHmac("sha256", sessionSecret(db)).update(id).digest("base64url");
}

/** A session at any stage: the second-step pages read one that is still waiting (#309). */
export function sessionAtStage(
  value: string | undefined,
  now = Date.now(),
  db: Database = getDb(),
): { id: string; person: Person; stage: SessionStage; next: string | null; expiresAt: number } | null {
  if (!value) {
    return null;
  }
  const dot = value.indexOf(".");
  if (dot <= 0) {
    return null;
  }
  const id = value.slice(0, dot);
  if (!safeEqual(value.slice(dot + 1), sign(id, db))) {
    return null;
  }
  const row = db.query("SELECT person_id, epoch, expires_at, stage, next FROM sessions WHERE id = ?").get(id) as
    | { person_id: string; epoch: number; expires_at: number; stage: SessionStage; next: string | null }
    | null;
  if (!row || row.expires_at <= now) {
    return null;
  }
  const person = personById(row.person_id, db);
  if (!person || person.revoked_at !== null || person.session_epoch !== row.epoch) {
    return null;
  }
  return { id, person, stage: row.stage, next: row.next, expiresAt: row.expires_at };
}

/** Moves a waiting session on; a full one gets its 30 days from now. */
export function setSessionStage(id: string, stage: SessionStage, now = Date.now(), db: Database = getDb()): void {
  const expiresAt = now + (stage === "full" ? sessionMs : pendingMs);
  db.query("UPDATE sessions SET stage = ?, expires_at = ?, last_seen_at = ? WHERE id = ?").run(stage, expiresAt, now, id);
}

/** The person a session cookie belongs to, and when it ends; it slides forward once an hour. */
export function sessionPerson(
  value: string | undefined,
  now = Date.now(),
  db: Database = getDb(),
): { person: Person; expiresAt: number } | null {
  if (!value) {
    return null;
  }
  const dot = value.indexOf(".");
  if (dot <= 0) {
    return null;
  }
  const id = value.slice(0, dot);
  if (!safeEqual(value.slice(dot + 1), sign(id, db))) {
    return null;
  }
  const row = db.query("SELECT person_id, epoch, expires_at, last_seen_at, stage FROM sessions WHERE id = ?").get(id) as
    | { person_id: string; epoch: number; expires_at: number; last_seen_at: number; stage: SessionStage }
    | null;
  // Only a session past its second step signs anything in.
  if (!row || row.expires_at <= now || row.stage !== "full") {
    return null;
  }
  const person = personById(row.person_id, db);
  if (!person || person.revoked_at !== null || person.session_epoch !== row.epoch) {
    return null;
  }
  let expiresAt = row.expires_at;
  if (now - row.last_seen_at > 60 * 60_000) {
    expiresAt = now + sessionMs;
    db.query("UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE id = ?").run(expiresAt, now, id);
    notePersonSeen(person.id, now, db);
  }
  return { person, expiresAt };
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

/** Ends every session of a person on their next request. */
export function endSessionsOf(personId: string, db: Database = getDb()): void {
  db.query("UPDATE people SET session_epoch = session_epoch + 1 WHERE id = ?").run(personId);
  db.query("DELETE FROM sessions WHERE person_id = ?").run(personId);
}

const seenWritten = new Map<string, number>();
export function notePersonSeen(personId: string, now = Date.now(), db: Database = getDb()): void {
  if (now - (seenWritten.get(personId) ?? 0) < 60_000) {
    return;
  }
  seenWritten.set(personId, now);
  try {
    db.query("UPDATE people SET last_seen_at = ? WHERE id = ?").run(now, personId);
  } catch {
    // a read-only moment is not worth failing a request over
  }
}

// ---- Personal tokens and service accounts ----

export type PersonToken = {
  id: string;
  person_id: string;
  name: string;
  read_only: number;
  created_at: number;
  created_by: string | null;
  expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
};

const yearMs = 366 * 24 * 60 * 60_000;

/** A token that acts as its person (or service account), shown once and kept hashed. */
export function createPersonToken(
  personId: string,
  input: { name: string; read_only?: boolean; expires_at?: number; created_by?: string | null },
  now = Date.now(),
  db: Database = getDb(),
): { token: string; row: PersonToken } {
  const name = input.name.trim();
  if (!name || name.length > 80) {
    throw new Error("A token needs a name of 1 to 80 characters");
  }
  const expiresAt = Math.min(input.expires_at ?? now + 365 * 24 * 60 * 60_000, now + yearMs);
  if (!(expiresAt > now)) {
    throw new Error("A token must expire in the future, within a year");
  }
  const token = `${tokenPrefix}${randomBytes(24).toString("base64url")}`;
  const id = randomUUID();
  db.query(
    "INSERT INTO person_tokens (id, person_id, name, token_hash, read_only, created_at, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, personId, name, hash(token), input.read_only ? 1 : 0, now, input.created_by ?? null, expiresAt);
  return { token, row: db.query("SELECT * FROM person_tokens WHERE id = ?").get(id) as PersonToken };
}

export function isPersonTokenShape(presented: string): boolean {
  return presented.startsWith(tokenPrefix);
}

const tokenUseWritten = new Map<string, number>();

/** Who a personal or service token acts as, while it and its person are live. */
export function tokenActor(presented: string, now = Date.now(), db: Database = getDb()): Actor | null {
  if (!isPersonTokenShape(presented)) {
    return null;
  }
  const row = db.query("SELECT * FROM person_tokens WHERE token_hash = ?").get(hash(presented)) as PersonToken | null;
  if (!row || row.revoked_at !== null || row.expires_at <= now) {
    return null;
  }
  const person = personById(row.person_id, db);
  if (!person || person.revoked_at !== null) {
    return null;
  }
  if (now - (tokenUseWritten.get(row.id) ?? 0) >= 60_000) {
    tokenUseWritten.set(row.id, now);
    try {
      db.query("UPDATE person_tokens SET last_used_at = ? WHERE id = ?").run(now, row.id);
    } catch {
      // as above
    }
  }
  const readOnly = row.read_only === 1;
  return { person, via: "token", token: { id: row.id, name: row.name, read_only: readOnly }, role: readOnly ? "viewer" : person.role };
}

export function tokensOf(personId: string, db: Database = getDb()): PersonToken[] {
  return db
    .query("SELECT * FROM person_tokens WHERE person_id = ? AND revoked_at IS NULL ORDER BY created_at DESC")
    .all(personId) as PersonToken[];
}

export function revokePersonToken(id: string, now = Date.now(), db: Database = getDb()): boolean {
  return db.query("UPDATE person_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, id).changes > 0;
}

/** A People row that cannot sign in and only holds tokens: a script that is not a person (32f). */
export function createServiceAccount(
  input: { name: string; role: Role; created_by?: string | null },
  now = Date.now(),
  db: Database = getDb(),
): Person {
  const name = input.name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new Error("A service account's name is 1 to 64 letters, digits, . _ or -, starting with a letter or digit");
  }
  const taken = db.query("SELECT id FROM people WHERE kind = 'service' AND name = ? AND revoked_at IS NULL").get(name);
  if (taken) {
    throw new Error(`A service account named ${name} exists`);
  }
  const id = randomUUID();
  db.query("INSERT INTO people (id, kind, name, email, role, created_at, created_by) VALUES (?, 'service', ?, NULL, ?, ?, ?)").run(
    id,
    name,
    input.role,
    now,
    input.created_by ?? null,
  );
  return personById(id, db)!;
}

export function serviceAccountByName(name: string, db: Database = getDb()): Person | null {
  return (
    (db.query("SELECT * FROM people WHERE kind = 'service' AND name = ? AND revoked_at IS NULL").get(name) as Person | null) ?? null
  );
}

/** What `GET /api/me` says about the actor. */
export function meBody(actor: Actor): Record<string, unknown> {
  return {
    id: actor.person.id,
    kind: actor.person.kind,
    name: actor.person.name,
    email: actor.person.email,
    role: actor.role,
    person_role: actor.person.role,
    via: actor.via,
    token: actor.token ? { name: actor.token.name, read_only: actor.token.read_only } : null,
  };
}

/** Initials for the header (30a): "Ian" → "IA", "Maya K." → "MK". */
export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return "?";
  }
  if (words.length === 1) {
    return words[0]!.slice(0, 2).toUpperCase();
  }
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}

// ---- Invites (30b, 30c): a link that works once; no mail server ----

const invitePrefix = "tsi1_";
export const inviteDays = [1, 7, 30] as const;

export type Invite = {
  id: string;
  who: string;
  role: Role;
  created_at: number;
  created_by: string | null;
  expires_at: number;
  used_at: number | null;
  used_by: string | null;
  cancelled_at: number | null;
};

/** An invite for an email or a name, with a role, for 1, 7 or 30 days; the token is shown once. */
export function createInvite(
  input: { who: string; role: Role; days?: number; created_by: string | null },
  now = Date.now(),
  db: Database = getDb(),
): { token: string; invite: Invite } | { error: string } {
  const who = input.who.trim();
  if (!who || who.length > 120) {
    return { error: "An invite names an email or a person, up to 120 characters" };
  }
  if (looksLikeEmail(who)) {
    const existing = personByEmail(who, db);
    if (existing && existing.revoked_at === null) {
      return { error: `${normalEmail(who)} can already sign in here` };
    }
  }
  const days = input.days ?? 7;
  if (!(inviteDays as readonly number[]).includes(days)) {
    return { error: "An invite works for 1, 7 or 30 days" };
  }
  const token = `${invitePrefix}${randomBytes(24).toString("base64url")}`;
  const id = randomUUID();
  db.query(
    "INSERT INTO invites (id, who, role, token_hash, created_at, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, looksLikeEmail(who) ? normalEmail(who) : who, input.role, hash(token), now, input.created_by, now + days * 24 * 60 * 60_000);
  return { token, invite: db.query("SELECT * FROM invites WHERE id = ?").get(id) as Invite };
}

/** Invites still waiting: not used, not cancelled, not expired. */
export function openInvites(now = Date.now(), db: Database = getDb()): Invite[] {
  return db
    .query("SELECT * FROM invites WHERE used_at IS NULL AND cancelled_at IS NULL AND expires_at > ? ORDER BY created_at DESC")
    .all(now) as Invite[];
}

export function cancelInvite(id: string, now = Date.now(), db: Database = getDb()): boolean {
  return db.query("UPDATE invites SET cancelled_at = ? WHERE id = ? AND used_at IS NULL AND cancelled_at IS NULL").run(now, id).changes > 0;
}

export function inviteFor(token: string, now = Date.now(), db: Database = getDb()): Invite | null {
  if (!token.startsWith(invitePrefix)) {
    return null;
  }
  const row = db.query("SELECT * FROM invites WHERE token_hash = ?").get(hash(token)) as Invite | null;
  if (!row || row.used_at !== null || row.cancelled_at !== null || row.expires_at <= now) {
    return null;
  }
  return row;
}

/** Joins from an invite: a new person with the invite's role (30c right). */
export async function useInvite(
  token: string,
  input: { name: string; email: string; password: string },
  now = Date.now(),
  db: Database = getDb(),
): Promise<{ person: Person } | { error: string }> {
  const invite = inviteFor(token, now, db);
  if (!invite) {
    return { error: "This invite has been used, cancelled, or has expired. Ask whoever invited you for a new one." };
  }
  const email = looksLikeEmail(invite.who) ? invite.who : normalEmail(input.email);
  if (!looksLikeEmail(email)) {
    return { error: "Your email, to sign in with" };
  }
  if (personByEmail(email, db)) {
    return { error: `${email} can already sign in here` };
  }
  const problem = passwordProblem(input.password);
  if (problem) {
    return { error: problem };
  }
  const name = input.name.trim() || (looksLikeEmail(invite.who) ? email.split("@")[0]! : invite.who);
  const passwordHash = await Bun.password.hash(input.password, { algorithm: "argon2id" });
  const id = randomUUID();
  db.query(
    "INSERT INTO people (id, kind, name, email, role, password_hash, created_at, created_by) VALUES (?, 'person', ?, ?, ?, ?, ?, ?)",
  ).run(id, name, email, invite.role, passwordHash, now, invite.created_by);
  db.query("UPDATE invites SET used_at = ?, used_by = ? WHERE id = ?").run(now, id, invite.id);
  return { person: personById(id, db)! };
}

/** Changes a person's role; the last Owner who can sign in stays an Owner. */
export function setRole(personId: string, role: Role, db: Database = getDb()): string | null {
  const person = personById(personId, db);
  if (!person || person.revoked_at !== null) {
    return "No such person";
  }
  if (person.role === "owner" && role !== "owner" && person.kind === "person" && liveOwnerCount(db) <= 1) {
    return "This is the last Owner: make another Owner first";
  }
  db.query("UPDATE people SET role = ? WHERE id = ?").run(role, personId);
  return null;
}

/** Revokes a person or service account: their sessions and tokens end on the next request. */
export function revokePerson(personId: string, now = Date.now(), db: Database = getDb()): string | null {
  const person = personById(personId, db);
  if (!person || person.revoked_at !== null) {
    return "No such person";
  }
  if (person.role === "owner" && person.kind === "person" && liveOwnerCount(db) <= 1) {
    return "This is the last Owner: make another Owner first";
  }
  db.query("UPDATE people SET revoked_at = ? WHERE id = ?").run(now, personId);
  db.query("UPDATE person_tokens SET revoked_at = ? WHERE person_id = ? AND revoked_at IS NULL").run(now, personId);
  endSessionsOf(personId, db);
  return null;
}
