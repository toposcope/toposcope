import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { getDb } from "../control/index";
import { hashToken } from "../control/tokens";
import { defaultShareEmbed, parseShareEmbed, type ShareEmbed } from "./embed";
import { defaultShareLimits, parseShareLimits, type ShareLimits } from "./limits";
import { formatShareScope, parseShareScope, type ShareScope } from "./scope";
import { parseSharePanels, type SharePanel } from "./panels";

/** A share (#225): a scope of data and a secret. The secret is kept only as its hash. */
export type ShareRecord = {
  id: string;
  name: string;
  scope: ShareScope;
  limits: ShareLimits;
  embed: ShareEmbed;
  /** Named panels (#266): a page names one with `data-panel=`. */
  panels: SharePanel[];
  /** Whether a page may still pass its own params within the fence (#266, on by default). */
  raw_params: boolean;
  /** Epoch ms. */
  expires_at: number;
  revoked_at: number | null;
  created_at: number;
  updated_at: number;
};

type ShareRow = Omit<ShareRecord, "scope" | "limits" | "embed" | "panels" | "raw_params"> & { scope: string; limits: string; embed: string; panels: string; raw_params: number; secret_hash: string };

export const shareSecretPrefix = "tss1_";
/** A share lives a year at most. */
export const shareMaxDays = 365;
const dayMs = 86_400_000;

export function newShareSecret(): string {
  return `${shareSecretPrefix}${randomBytes(24).toString("base64url")}`;
}

/** A name to put in a URL and a log row: `agental-console`. */
export function parseShareName(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const name = raw.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(name) ? name : null;
}

/** `2027-10-23`, an ISO time, or epoch ms; after now and at most a year out. */
export function parseShareExpiry(raw: unknown, now = Date.now()): number | { error: string } {
  const ms =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() !== ""
        ? Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(raw.trim()) ? `${raw.trim()}T00:00:00Z` : raw.trim())
        : Number.NaN;
  if (!Number.isFinite(ms)) {
    return { error: "expires_at is required: a date, an ISO time or epoch ms" };
  }
  if (ms <= now) {
    return { error: "expires_at must be in the future" };
  }
  if (ms > now + shareMaxDays * dayMs) {
    return { error: `expires_at is at most ${shareMaxDays} days out` };
  }
  return Math.trunc(ms);
}

function fromRow(row: ShareRow): ShareRecord {
  const scope = parseShareScope(JSON.parse(row.scope));
  if ("error" in scope) {
    throw new Error(`share ${row.name}: stored scope does not parse: ${scope.error}`);
  }
  const limits = parseShareLimits(JSON.parse(row.limits));
  const embed = parseShareEmbed(JSON.parse(row.embed));
  const panels = parseSharePanels(JSON.parse(row.panels || "[]"));
  return {
    id: row.id,
    name: row.name,
    scope,
    limits: "error" in limits ? defaultShareLimits : limits,
    embed: "error" in embed ? defaultShareEmbed : embed,
    panels: "error" in panels ? [] : panels,
    raw_params: row.raw_params !== 0,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const columns = "id, name, scope, limits, embed, panels, raw_params, secret_hash, expires_at, revoked_at, created_at, updated_at";

function storedScope(scope: ShareScope): string {
  return JSON.stringify(formatShareScope(scope));
}

export function listShares(db: Database = getDb()): ShareRecord[] {
  const rows = db.query(`SELECT ${columns} FROM shares ORDER BY revoked_at IS NOT NULL, name`).all() as ShareRow[];
  return rows.map(fromRow);
}

export function shareByName(name: string, db: Database = getDb()): ShareRecord | null {
  const row = db.query(`SELECT ${columns} FROM shares WHERE name = ?`).get(name) as ShareRow | null;
  return row ? fromRow(row) : null;
}

/** A share by id, revoked or not: what a ticket names. */
export function shareById(id: string, db: Database = getDb()): ShareRecord | null {
  const row = db.query(`SELECT ${columns} FROM shares WHERE id = ?`).get(id) as ShareRow | null;
  return row ? fromRow(row) : null;
}

/** The hash a share's tickets are signed with: its secret's, so a new secret ends every ticket. */
export function shareSecretHash(id: string, db: Database = getDb()): string | null {
  const row = db.query("SELECT secret_hash FROM shares WHERE id = ?").get(id) as { secret_hash: string } | null;
  return row?.secret_hash ?? null;
}

/** The share a secret opens, or null: unknown, revoked and expired all answer the same. */
export function shareBySecret(secret: string, now = Date.now(), db: Database = getDb()): ShareRecord | null {
  if (!secret.startsWith(shareSecretPrefix)) {
    return null;
  }
  const row = db.query(`SELECT ${columns} FROM shares WHERE secret_hash = ?`).get(hashToken(secret)) as ShareRow | null;
  if (!row || row.revoked_at !== null || row.expires_at <= now) {
    return null;
  }
  return fromRow(row);
}

/**
 * Create a share, or change one in place (#228's `PUT`). A new share, or one replacing a revoked
 * share of that name, gets a new secret, returned once; changing a live share keeps its secret.
 */
export function putShare(
  input: { name: string; scope: ShareScope; limits: ShareLimits; embed: ShareEmbed; panels?: SharePanel[]; raw_params?: boolean; expires_at: number },
  now = Date.now(),
  db: Database = getDb(),
): { share: ShareRecord; secret: string | null; created: boolean } {
  const existing = shareByName(input.name, db);
  if (existing && existing.revoked_at === null) {
    db.query("UPDATE shares SET scope = ?, limits = ?, embed = ?, panels = ?, raw_params = ?, expires_at = ?, updated_at = ? WHERE id = ?").run(
      storedScope(input.scope),
      JSON.stringify(input.limits),
      JSON.stringify(input.embed),
      JSON.stringify(input.panels ?? existing.panels),
      (input.raw_params ?? existing.raw_params) ? 1 : 0,
      input.expires_at,
      now,
      existing.id,
    );
    return { share: shareByName(input.name, db)!, secret: null, created: false };
  }
  const secret = newShareSecret();
  db.transaction(() => {
    if (existing) {
      db.query("DELETE FROM shares WHERE id = ?").run(existing.id);
    }
    db.query(`INSERT INTO shares (${columns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`).run(
      crypto.randomUUID(),
      input.name,
      storedScope(input.scope),
      JSON.stringify(input.limits),
      JSON.stringify(input.embed),
      JSON.stringify(input.panels ?? []),
      (input.raw_params ?? true) ? 1 : 0,
      hashToken(secret),
      input.expires_at,
      now,
      now,
    );
  })();
  return { share: shareByName(input.name, db)!, secret, created: true };
}

/** Revoke at once: the row stays, so the list can say it was revoked and when. */
export function revokeShare(name: string, now = Date.now(), db: Database = getDb()): ShareRecord | null {
  db.query("UPDATE shares SET revoked_at = ?, updated_at = ? WHERE name = ? AND revoked_at IS NULL").run(now, now, name);
  return shareByName(name, db);
}
