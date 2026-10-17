import type { Database } from "bun:sqlite";
import type { Context } from "hono";
import { applyRetentionDays, clampRetentionDays } from "../shared/migrate";
import { getDb } from "./index";
import { setHereName } from "../shared/here";
import { instanceName, parseInstanceName, writeInstanceName } from "./instance";

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
  return c.json({ retention_days: getRetentionDays(), instance_name: instanceName() });
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
  const hasName = "instance_name" in rec;
  if (rec.retention_days === undefined && !hasName) {
    return c.json({ error: "retention_days is required" }, 400);
  }
  if (rec.retention_days !== undefined && typeof rec.retention_days !== "number") {
    return c.json({ error: "retention_days is required" }, 400);
  }
  if (
    typeof rec.retention_days === "number" &&
    (!Number.isInteger(rec.retention_days) || rec.retention_days < 1 || rec.retention_days > 365)
  ) {
    return c.json({ error: "Retention must be 1–365 whole days" }, 400);
  }
  // The name is checked before anything is written, so a bad name changes nothing.
  const name = hasName ? parseInstanceName(rec.instance_name) : undefined;
  if (name && typeof name === "object") {
    return c.json({ error: name.error }, 400);
  }
  const savedName = name === undefined ? instanceName() : writeInstanceName(name);
  // Rows ingested from now on are stamped with the new name; rows stored keep the old one.
  setHereName(savedName);
  if (typeof rec.retention_days !== "number") {
    return c.json({ retention_days: getRetentionDays(), instance_name: savedName });
  }
  const days = writeRetentionDays(rec.retention_days);
  try {
    await applyRetentionDays(days);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "ClickHouse command failed";
    return c.json({ error: message.slice(0, 500), retention_days: days, instance_name: savedName }, 500);
  }
  return c.json({ retention_days: days, instance_name: savedName });
}
