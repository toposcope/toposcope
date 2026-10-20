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

/**
 * The webhook any monitor without its own calls (#177), such as one created by its first result.
 * Null when none is set: such a monitor keeps its state and calls nobody.
 */
export function getDefaultWebhook(db: Database = getDb()): string | null {
  const row = db.query("SELECT value FROM settings WHERE key = 'default_webhook_url'").get() as
    | { value: string }
    | undefined;
  return row?.value ? row.value : null;
}

/** An http(s) URL, or empty for none. */
export function parseDefaultWebhook(value: unknown): string | null | { error: string } {
  if (value === null || value === "") {
    return null;
  }
  const url = typeof value === "string" ? value.trim() : "";
  if (url === "") {
    return null;
  }
  if (!/^https?:\/\/\S+$/.test(url) || url.length > 2000) {
    return { error: "default_webhook_url must be http(s), or empty for none" };
  }
  return url;
}

export function writeDefaultWebhook(url: string | null, db: Database = getDb()): void {
  if (url === null) {
    db.query("DELETE FROM settings WHERE key = 'default_webhook_url'").run();
    return;
  }
  db.query(
    "INSERT INTO settings (key, value) VALUES ('default_webhook_url', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(url);
}

function settingsBody(extra: { retention_days: number; instance_name: string | null }) {
  return { ...extra, default_webhook_url: getDefaultWebhook() };
}

export async function getSettings(c: Context): Promise<Response> {
  return c.json(settingsBody({ retention_days: getRetentionDays(), instance_name: instanceName() }));
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
  const hasWebhook = "default_webhook_url" in rec;
  if (rec.retention_days === undefined && !hasName && !hasWebhook) {
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
  const webhook = hasWebhook ? parseDefaultWebhook(rec.default_webhook_url) : undefined;
  if (webhook && typeof webhook === "object") {
    return c.json({ error: webhook.error }, 400);
  }
  if (webhook !== undefined) {
    writeDefaultWebhook(webhook);
  }
  const savedName = name === undefined ? instanceName() : writeInstanceName(name);
  // Rows ingested from now on are stamped with the new name; rows stored keep the old one.
  setHereName(savedName);
  if (typeof rec.retention_days !== "number") {
    return c.json(settingsBody({ retention_days: getRetentionDays(), instance_name: savedName }));
  }
  const days = writeRetentionDays(rec.retention_days);
  try {
    await applyRetentionDays(days);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "ClickHouse command failed";
    return c.json({ error: message.slice(0, 500), ...settingsBody({ retention_days: days, instance_name: savedName }) }, 500);
  }
  return c.json(settingsBody({ retention_days: days, instance_name: savedName }));
}
