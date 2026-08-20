import { createHash, randomBytes } from "node:crypto";
import type { Context } from "hono";
import { getDb } from "./index";

export type ApiToken = {
  id: string;
  name: string;
  created_at: number;
};

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function tokenHashExists(tokenHash: string): boolean {
  const row = getDb()
    .query("SELECT id FROM api_tokens WHERE token_hash = ?")
    .get(tokenHash) as { id: string } | undefined;
  return row !== undefined;
}

function allTokens(): ApiToken[] {
  return getDb()
    .query("SELECT id, name, created_at FROM api_tokens ORDER BY created_at DESC")
    .all() as ApiToken[];
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
