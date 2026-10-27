import { twoStepFor, writeTwoStepFor } from "./two-step";
import { settingStamp, stampSetting } from "./actors";
import type { Database } from "bun:sqlite";
import type { Context } from "hono";
import {
  applyRetentionDays,
  clampMetricsRetentionDays,
  clampRetentionDays,
  maxMetricsRetentionDays,
} from "../shared/migrate";
import { getDb } from "./index";
import { setHereName } from "../shared/here";
import { instanceName, parseInstanceName, writeInstanceName } from "./instance";

export type Settings = {
  retention_days: number;
  /** Null: metrics follow `retention_days`. */
  metrics_retention_days: number | null;
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

/** Metrics' own retention, or null when they follow logs. */
export function getMetricsRetentionDays(db: Database = getDb()): number | null {
  const row = db
    .query("SELECT value FROM settings WHERE key = 'metrics_retention_days'")
    .get() as { value: string } | null;
  if (!row) {
    return null;
  }
  return clampMetricsRetentionDays(Number(row.value));
}

/** The days the metric tables keep: their own, else what logs keep. */
export function effectiveMetricsRetentionDays(db: Database = getDb()): number {
  return getMetricsRetentionDays(db) ?? getRetentionDays(db);
}

export function writeMetricsRetentionDays(
  days: number | null,
  db: Database = getDb(),
): number | null {
  if (days === null) {
    db.query("DELETE FROM settings WHERE key = 'metrics_retention_days'").run();
    return null;
  }
  const n = clampMetricsRetentionDays(days);
  db.query(
    "INSERT INTO settings (key, value) VALUES ('metrics_retention_days', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(n));
  return n;
}

/** A whole number of days in range, or null (or empty) for none. */
export function parseMetricsRetentionDays(value: unknown): number | null | { error: string } {
  if (value === null || value === "") {
    return null;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > maxMetricsRetentionDays
  ) {
    return { error: `Metrics retention must be 1–${maxMetricsRetentionDays} whole days, or null to follow retention_days` };
  }
  return value;
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
  return {
    ...extra,
    metrics_retention_days: getMetricsRetentionDays(),
    default_webhook_url: getDefaultWebhook(),
    two_step_for: twoStepFor(),
    // #307: who last changed each, and when.
    changed_by: Object.fromEntries(
      ["retention_days", "metrics_retention_days", "default_webhook_url", "instance_name", "fields"].map((k) => [k, settingStamp(k)]),
    ),
  };
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
  const hasMetrics = "metrics_retention_days" in rec;
  if (rec.retention_days === undefined && !hasName && !hasWebhook && !hasMetrics && rec.two_step_for === undefined) {
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
  const metricsDays = hasMetrics ? parseMetricsRetentionDays(rec.metrics_retention_days) : undefined;
  if (metricsDays && typeof metricsDays === "object") {
    return c.json({ error: metricsDays.error }, 400);
  }
  // #309: who must have a second step: everyone with a password, or Owners only.
  if (rec.two_step_for !== undefined) {
    if (rec.two_step_for !== "everyone" && rec.two_step_for !== "owners") {
      return c.json({ error: "two_step_for is everyone or owners" }, 400);
    }
    writeTwoStepFor(rec.two_step_for);
    stampSetting("two_step_for");
  }
  if (webhook !== undefined) {
    writeDefaultWebhook(webhook);
    stampSetting("default_webhook_url");
  }
  if (name !== undefined) {
    stampSetting("instance_name");
  }
  const savedName = name === undefined ? instanceName() : writeInstanceName(name);
  // Rows ingested from now on are stamped with the new name; rows stored keep the old one.
  setHereName(savedName);
  if (metricsDays !== undefined) {
    writeMetricsRetentionDays(metricsDays);
    stampSetting("metrics_retention_days");
  }
  if (typeof rec.retention_days !== "number" && !hasMetrics) {
    return c.json(settingsBody({ retention_days: getRetentionDays(), instance_name: savedName }));
  }
  const days =
    typeof rec.retention_days === "number" ? writeRetentionDays(rec.retention_days) : getRetentionDays();
  if (typeof rec.retention_days === "number") {
    stampSetting("retention_days");
  }
  try {
    await applyRetentionDays(days, effectiveMetricsRetentionDays());
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "ClickHouse command failed";
    return c.json({ error: message.slice(0, 500), ...settingsBody({ retention_days: days, instance_name: savedName }) }, 500);
  }
  return c.json(settingsBody({ retention_days: days, instance_name: savedName }));
}
