import type { FieldRole } from "./fields";

/** ±5m around the selected event (10m span). */
export const FOLLOW_MS = 300_000;

/** First present alias fills `logs.trace_id` at ingest. */
export const TRACE_ID_KEYS = ["trace_id", "traceid", "request_id", "req_id"] as const;

/** View trace prefers `trace_id`, then `request_id`, then the other ingest aliases. */
export const JOIN_TRACE_KEYS = ["trace_id", "request_id", "traceid", "req_id"] as const;

const otelTraceIdRe = /^[0-9a-fA-F]{32}$/;
const otelSpanIdRe = /^[0-9a-fA-F]{16}$/;

/** OTLP TraceId: 32 hex, not all zeros. Lowercased. */
export function parseOtelTraceId(raw: string): string | null {
  const id = raw.trim();
  if (!otelTraceIdRe.test(id) || /^0+$/.test(id)) {
    return null;
  }
  return id.toLowerCase();
}

/** OTLP SpanId: 16 hex, not all zeros. Lowercased. */
export function parseOtelSpanId(raw: string): string | null {
  const id = raw.trim();
  if (!otelSpanIdRe.test(id) || /^0+$/.test(id)) {
    return null;
  }
  return id.toLowerCase();
}

export function isOtelTraceId(raw: string): boolean {
  return parseOtelTraceId(raw) !== null;
}

const followBlocked = new Set(["ts", "level", "message", "service", "host"]);

const uuidRe =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const hex16Re = /^[0-9a-fA-F]{16,}$/;
const prefixedIdRe = /^[a-z]{2,5}[_-][0-9a-z]{6,}$/i;
const ulidRe = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** UUID, ≥16 hex, `usr_8f3a1c`-style, or ULID — not rolled up; Follow-able. */
export function isIdShapedValue(value: string): boolean {
  if (value.length < 8) {
    return false;
  }
  return (
    uuidRe.test(value) ||
    hex16Re.test(value) ||
    prefixedIdRe.test(value) ||
    ulidRe.test(value)
  );
}

export function pickTraceId(attrs: Record<string, string>): string {
  for (const key of TRACE_ID_KEYS) {
    const value = attrs[key];
    if (value) {
      return value;
    }
  }
  return "";
}

/** OTLP JSON hex or protobuf base64/bytes → lowercase hex. Empty / all-zero is missing. */
export function otlpIdHex(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || /^0+$/.test(trimmed)) {
      return undefined;
    }
    if (/^[0-9a-fA-F]{16,32}$/.test(trimmed)) {
      return trimmed.toLowerCase();
    }
    try {
      const buf = Buffer.from(trimmed, "base64");
      if (buf.length === 8 || buf.length === 16) {
        if (buf.every((b) => b === 0)) {
          return undefined;
        }
        return buf.toString("hex");
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
  if (raw instanceof Uint8Array) {
    if (raw.length === 0 || raw.every((b) => b === 0)) {
      return undefined;
    }
    if (raw.length === 8 || raw.length === 16) {
      return Buffer.from(raw).toString("hex");
    }
  }
  return undefined;
}

export function canFollowField(
  key: string,
  value: string,
  role: FieldRole | undefined,
): boolean {
  if (followBlocked.has(key) || value.length === 0) {
    return false;
  }
  if (role === "lookup") {
    return true;
  }
  return isIdShapedValue(value);
}

export function followScanRole(role: FieldRole | undefined): FieldRole {
  return role ?? "chart";
}

export function joinTraceRef(
  attrs: Record<string, unknown> | undefined,
): { key: string; value: string } | null {
  if (!attrs) {
    return null;
  }
  for (const key of JOIN_TRACE_KEYS) {
    const raw = attrs[key];
    if (typeof raw !== "string") {
      continue;
    }
    const value = parseOtelTraceId(raw);
    if (value) {
      return { key, value };
    }
  }
  return null;
}
