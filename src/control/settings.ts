import type { Database } from "bun:sqlite";
import type { Context } from "hono";
import { applyRetentionDays, clampRetentionDays } from "../shared/migrate";
import { getDb } from "./index";

export type Settings = {
  retention_days: number;
};

export function getRetentionDays(db: Database = getDb()): number {
  const row = db
    .query("SELECT value FROM settings WHERE key = 'retention_days'")
    .get() as { value: string } | undefined;
  const n = Number(row?.value ?? 30);
  return clampRetentionDays(n);
}

export function writeRetentionDays(
  days: number,
  db: Database = getDb(),
): number {
  const n = clampRetentionDays(days);
  db.query(
    "INSERT INTO settings (key, value) VALUES ('retention_days', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(n));
  return n;
}

export async function getSettings(c: Context): Promise<Response> {
  return c.json({ retention_days: getRetentionDays() });
}

export async function putSettings(c: Context): Promise<Response> {
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
  if (typeof rec.retention_days !== "number") {
    return c.json({ error: "retention_days is required" }, 400);
  }
  const days = writeRetentionDays(rec.retention_days);
  try {
    await applyRetentionDays(days);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "ClickHouse command failed";
    return c.json({ error: message.slice(0, 500), retention_days: days }, 500);
  }
  return c.json({ retention_days: days });
}
