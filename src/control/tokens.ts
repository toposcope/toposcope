import { stampCreated } from "./actors";
import { createHash, randomBytes } from "node:crypto";
import type { Context } from "hono";
import { getDb } from "./index";

export type ApiToken = {
  id: string;
  name: string;
  created_at: number;
  last_used_at?: number | null;
  created_by?: string | null;
};

/** The name the `.env` ingest token takes in Access when 0.9 imports it (#308). */
export const importedTokenName = "env (imported)";

/**
 * Takes `TOPOSCOPE_INGEST_TOKEN` into Access once, as an ingest token named `env (imported)`, so
 * collectors keep sending; from then the `.env` line is never read again (#308). Returns whether
 * it imported now.
 */
export function importEnvIngestToken(value: string | undefined, now = Date.now()): boolean {
  const db = getDb();
  if (db.query("SELECT value FROM settings WHERE key = 'env_ingest_token_imported'").get()) {
    return false;
  }
  db.query("INSERT INTO settings (key, value) VALUES ('env_ingest_token_imported', ?)").run(String(now));
  if (!value) {
    return false;
  }
  const hash = hashToken(value);
  if (db.query("SELECT id FROM api_tokens WHERE token_hash = ?").get(hash)) {
    return false;
  }
  db.query("INSERT INTO api_tokens (id, name, token_hash, created_at, created_by) VALUES (?, ?, ?, ?, 'env')").run(
    crypto.randomUUID(),
    importedTokenName,
    hash,
    now,
  );
  return true;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function tokenHashExists(tokenHash: string): boolean {
  const row = getDb()
    .query("SELECT id FROM api_tokens WHERE token_hash = ?")
    .get(tokenHash) as { id: string } | null | undefined;
  // bun:sqlite answers null, not undefined, when no row matches.
  return Boolean(row);
}

export function allTokens(): ApiToken[] {
  return getDb()
    .query("SELECT id, name, created_at, last_used_at, created_by FROM api_tokens ORDER BY created_at DESC")
    .all() as ApiToken[];
}

/** The token a hash belongs to (#265): its use is counted under its name. */
export function tokenByHash(tokenHash: string): { id: string; name: string } | null {
  const row = getDb().query("SELECT id, name FROM api_tokens WHERE token_hash = ?").get(tokenHash) as { id: string; name: string } | null | undefined;
  return row ?? null;
}

const lastUseWritten = new Map<string, number>();
/** At most once a minute per token: the list's Last used. */
export function noteTokenUsedAt(id: string, now = Date.now()): void {
  if (now - (lastUseWritten.get(id) ?? 0) < 60_000) {
    return;
  }
  lastUseWritten.set(id, now);
  try {
    getDb().query("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(now, id);
  } catch {
    // a read-only moment is not worth failing an ingest over
  }
}

export async function listApiTokens(c: Context): Promise<Response> {
  return c.json({ tokens: allTokens() });
}

export async function createApiToken(c: Context): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (!body || typeof body !== "object") {
    return c.json({ error: "Expected an object" }, 400);
  }
  const rec = body as Record<string, unknown>;
  const name = typeof rec.name === "string" ? rec.name.trim() : "";
  if (name.length === 0) {
    return c.json({ error: "name is required" }, 400);
  }
  const token = randomBytes(24).toString("base64url");
  const id = crypto.randomUUID();
  const created_at = Date.now();
  getDb()
    .query(
      "INSERT INTO api_tokens (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(id, name, hashToken(token), created_at);
  stampCreated("api_tokens", id);
  return c.json({ id, name, token, created_at }, 201);
}

export async function deleteApiToken(c: Context): Promise<Response> {
  const id = c.req.param("id");
  if (!id) {
    return c.json({ error: "id required" }, 400);
  }
  const existing = getDb()
    .query("SELECT id FROM api_tokens WHERE id = ?")
    .get(id) as { id: string } | undefined;
  if (!existing) {
    return c.json({ error: "Token not found" }, 404);
  }
  getDb().query("DELETE FROM api_tokens WHERE id = ?").run(id);
  return c.json({ ok: true });
}
