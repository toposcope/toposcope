import { attrIdent, maxAttrKeysPerEvent } from "./attrs";

export const maxMetricLabels = 4;

export type MetricPoint = {
  ts: string;
  name: string;
  value: number;
  labels: Record<string, string>;
};

export class InvalidMetricError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMetricError";
  }
}

/** Metric names and label keys may be `service` / `host` (unlike log attr idents). */
export function isMetricIdent(key: string): boolean {
  return attrIdent.test(key);
}

export function parseMetricName(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  const name = raw.trim().toLowerCase();
  return isMetricIdent(name) ? name : null;
}

export function requireMetricName(raw: string | null | undefined): string {
  const name = parseMetricName(raw);
  if (!name) {
    throw new InvalidMetricError(raw ? `Invalid metric "${raw}"` : "Missing metric");
  }
  return name;
}

/** `service:api,host:api-1` — equality matchers only. Cap 4. */
export function parseMetricLabels(
  raw: string | null | undefined,
): Record<string, string> {
  if (!raw) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const colon = part.indexOf(":");
    if (colon <= 0) {
      continue;
    }
    const key = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim();
    if (!isMetricIdent(key) || value.length === 0 || key in out) {
      continue;
    }
    out[key] = value;
    if (Object.keys(out).length >= maxMetricLabels) {
      break;
    }
  }
  return out;
}

export function formatMetricLabels(labels: Record<string, string>): string {
  return Object.entries(labels)
    .filter(([key, value]) => isMetricIdent(key) && value.length > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, maxMetricLabels)
    .map(([key, value]) => `${key}:${value}`)
    .join(",");
}

export function metricExpr(
  name: string,
  labels: Record<string, string>,
): string {
  const encoded = formatMetricLabels(labels);
  return encoded.length > 0 ? `${name}{${encoded.replaceAll(":", "=")}}` : name;
}

export function parseMetricPoint(input: unknown): MetricPoint {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new InvalidMetricError("Invalid metric point");
  }
  const rec = input as Record<string, unknown>;
  const name = parseMetricName(typeof rec.name === "string" ? rec.name : "");
  if (!name) {
    throw new InvalidMetricError("Metric name must be an ident");
  }
  const value = rec.value;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidMetricError("Metric value must be a finite number");
  }
  const tsRaw = rec.ts;
  const ts =
    typeof tsRaw === "string" && !Number.isNaN(Date.parse(tsRaw))
      ? new Date(tsRaw).toISOString()
      : new Date().toISOString();
  const labels = flattenMetricLabels(rec.labels);
  return { ts, name, value, labels };
}

function flattenMetricLabels(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= maxAttrKeysPerEvent) {
      break;
    }
    const key = rawKey.trim().toLowerCase();
    if (!isMetricIdent(key) || key in out) {
      continue;
    }
    if (typeof value === "string" && value.length > 0) {
      out[key] = value;
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = String(value);
    }
  }
  return out;
}
