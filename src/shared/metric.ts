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

/** How a histogram is read. One reading is drawn at a time. */
export const histogramReadings = ["count", "sum", "avg", "p50", "p90", "p99"] as const;
export type HistogramReading = (typeof histogramReadings)[number];
export const defaultHistogramReading: HistogramReading = "p99";

export function parseHistogramReading(raw: string | null | undefined): HistogramReading | null {
  return histogramReadings.find((reading) => reading === raw) ?? null;
}

/** The share of observations a percentile reading sits above, or null for count, sum and avg. */
export function readingQuantile(reading: HistogramReading): number | null {
  return reading === "p50" ? 0.5 : reading === "p90" ? 0.9 : reading === "p99" ? 0.99 : null;
}

/** A metric as a link carries it: its name, with a histogram's reading in front when one was chosen. */
export type MetricRef = { name: string; reading: HistogramReading | null };

/** `http.server.duration`, or `p99:http.server.duration`. */
export function parseMetricRef(raw: string | null | undefined): MetricRef | null {
  if (!raw) {
    return null;
  }
  const text = raw.trim();
  const colon = text.indexOf(":");
  const reading = colon > 0 ? parseHistogramReading(text.slice(0, colon).toLowerCase()) : null;
  if (colon >= 0 && !reading) {
    return null;
  }
  const name = parseMetricName(reading ? text.slice(colon + 1) : text);
  return name ? { name, reading } : null;
}

export function formatMetricRef(ref: MetricRef): string {
  return ref.reading ? `${ref.reading}:${ref.name}` : ref.name;
}

/** The link's metric in one spelling, or null when it is not one. */
export function normalizeMetricRef(raw: string | null | undefined): string | null {
  const ref = parseMetricRef(raw);
  return ref ? formatMetricRef(ref) : null;
}

export function requireMetricRef(raw: string | null | undefined): MetricRef {
  const ref = parseMetricRef(raw);
  if (!ref) {
    throw new InvalidMetricError(raw ? `Invalid metric "${raw}"` : "Missing metric");
  }
  return ref;
}

/** A histogram's bucket counts for one interval of one series. */
export type MetricBuckets = {
  ts: string;
  name: string;
  labels: Record<string, string>;
  /** Upper bounds, rising. */
  le: number[];
  /** What was observed up to each bound and above the one before; one more, last, for above them all. */
  n: number[];
};

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
  reading: HistogramReading | null = null,
): string {
  const encoded = formatMetricLabels(labels);
  const named = reading ? `${reading}:${name}` : name;
  return encoded.length > 0 ? `${named}{${encoded.replaceAll(":", "=")}}` : named;
}

/** Longer than this is not a unit; it is not kept. */
export const maxMetricUnitLength = 64;

/**
 * A metric's unit as the app sent it (`GiBy`, `s`, `{request}`), or null when
 * it sent none. Blank is none. It is kept as it came, not converted.
 */
export function metricUnitOf(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const unit = raw.trim();
  return unit.length > 0 && unit.length <= maxMetricUnitLength ? unit : null;
}

/** A JSON point's optional `unit`. Not a string, or too long, is refused; blank is none. */
export function parseMetricPointUnit(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const raw = (input as Record<string, unknown>).unit;
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== "string") {
    throw new InvalidMetricError("Metric unit must be a string");
  }
  if (raw.trim().length > maxMetricUnitLength) {
    throw new InvalidMetricError(`Metric unit is longer than ${maxMetricUnitLength} characters`);
  }
  return metricUnitOf(raw);
}

/** Longer than this is cut when it comes over OTLP, and refused on a JSON point. */
export const maxMetricDescriptionLength = 300;

/**
 * A metric's description as its sender wrote it, or null when it sent none.
 * Blank is none. Over OTLP a longer one is cut, not refused: the points are
 * still good.
 */
export function metricDescriptionOf(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const description = raw.trim();
  if (description.length === 0) {
    return null;
  }
  return description.length <= maxMetricDescriptionLength
    ? description
    : description.slice(0, maxMetricDescriptionLength).trimEnd();
}

/** A JSON point's optional `description`. Not a string, or too long, is refused; blank is none. */
export function parseMetricPointDescription(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const raw = (input as Record<string, unknown>).description;
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== "string") {
    throw new InvalidMetricError("Metric description must be a string");
  }
  if (raw.trim().length > maxMetricDescriptionLength) {
    throw new InvalidMetricError(`Metric description is longer than ${maxMetricDescriptionLength} characters`);
  }
  return metricDescriptionOf(raw);
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
