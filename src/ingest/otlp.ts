import { otlpIdHex } from "../shared/ids";
import { liftException } from "../shared/exception";
import { liftIdentities } from "../shared/identity";
import type { LogEvent, LogLevel } from "../shared/log-event";
import { levels } from "../shared/log-event";
import type { Losses } from "./otlp-reply";

/** The name OpenTelemetry gives the scope's name wherever it leaves OTLP. */
const scopeNameKey = "otel.scope.name";

const otlpSeverityNumber: Record<LogLevel, number> = {
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  fatal: 21,
};

type AnyVal = {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values?: AnyVal[] };
  kvlistValue?: { values?: { key?: string; value?: AnyVal }[] };
};

type Attr = {
  key?: string;
  value?: AnyVal;
};

function decodeAny(value: AnyVal | undefined): unknown {
  if (!value) {
    return undefined;
  }
  if (value.stringValue !== undefined) {
    return value.stringValue;
  }
  if (value.intValue !== undefined) {
    return Number(value.intValue);
  }
  if (value.doubleValue !== undefined) {
    return value.doubleValue;
  }
  if (value.boolValue !== undefined) {
    return value.boolValue;
  }
  if (value.arrayValue?.values) {
    return value.arrayValue.values.map((item) => decodeAny(item));
  }
  if (value.kvlistValue?.values) {
    const out: Record<string, unknown> = {};
    for (const kv of value.kvlistValue.values) {
      if (kv.key) {
        out[kv.key] = decodeAny(kv.value);
      }
    }
    return out;
  }
  return undefined;
}

function attrString(attrs: Attr[] | undefined, key: string): string | undefined {
  if (!attrs) {
    return undefined;
  }
  for (const attr of attrs) {
    if (attr.key !== key || !attr.value) {
      continue;
    }
    if (typeof attr.value.stringValue === "string" && attr.value.stringValue.length > 0) {
      return attr.value.stringValue;
    }
    if (attr.value.intValue !== undefined) {
      return String(attr.value.intValue);
    }
  }
  return undefined;
}

function attrRecord(attrs: Attr[] | undefined, skip: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!attrs) {
    return out;
  }
  for (const attr of attrs) {
    if (!attr.key || skip.has(attr.key) || !attr.value) {
      continue;
    }
    const decoded = decodeAny(attr.value);
    if (decoded !== undefined) {
      out[attr.key] = decoded;
    }
  }
  return out;
}

/**
 * The number decides when the sender set one (1–24). A record built by hand in a
 * collector often carries only a text, which is read by the words senders use.
 */
function mapSeverity(text: string | undefined, number: number | undefined): LogLevel {
  if (number !== undefined && number >= 1 && number <= 24) {
    if (number >= 21) {
      return "fatal";
    }
    if (number >= 17) {
      return "error";
    }
    if (number >= 13) {
      return "warn";
    }
    if (number >= 9) {
      return "info";
    }
    return "debug";
  }
  const lower = (text ?? "").toLowerCase();
  if (levels.includes(lower as LogLevel)) {
    return lower as LogLevel;
  }
  // Syslog's emerg, alert and crit are fatal here, as the syslog listener has them.
  if (["fatal", "emerg", "panic", "crit", "alert"].some((word) => lower.includes(word))) {
    return "fatal";
  }
  if (lower.includes("err") || lower.includes("severe")) {
    return "error";
  }
  if (lower.includes("warn")) {
    return "warn";
  }
  if (lower.includes("debug") || lower.includes("trace")) {
    return "debug";
  }
  return "info";
}

function tsFromNano(nano: string | number | undefined): string | undefined {
  if (nano === undefined) {
    return undefined;
  }
  const n = typeof nano === "number" ? nano : Number(nano);
  if (!Number.isFinite(n) || n <= 0) {
    return undefined;
  }
  return new Date(n / 1_000_000).toISOString();
}

/** The row's own columns. A map body often repeats them; they are not attributes. */
const rowColumns = new Set(["level", "service", "host", "ts", "message", "tenant_id"]);

type BodyRead =
  | { message: string; fields?: Record<string, unknown> }
  | { rejected: string };

/**
 * A record's line, and what a map body adds to its attributes. A string is the
 * line. A number or a boolean becomes its text. A map gives its `message` or
 * `msg` as the line, or itself as JSON, and its other top-level fields as
 * attributes. With no body, the event name is the line.
 */
function readBody(body: unknown, eventName: unknown): BodyRead {
  const value = (body && typeof body === "object" ? body : {}) as AnyVal & {
    bytesValue?: unknown;
  };
  if (typeof value.stringValue === "string" && value.stringValue.length > 0) {
    return { message: value.stringValue };
  }
  if (value.intValue !== undefined || value.doubleValue !== undefined) {
    return { message: String(decodeAny(value)) };
  }
  if (value.boolValue !== undefined) {
    return { message: String(value.boolValue) };
  }
  if (value.kvlistValue?.values && value.kvlistValue.values.length > 0) {
    const map = decodeAny(value) as Record<string, unknown>;
    const lineKey = ["message", "msg"].find(
      (key) => typeof map[key] === "string" && (map[key] as string).length > 0,
    );
    const fields: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(map)) {
      if (key !== lineKey && !rowColumns.has(key.toLowerCase())) {
        fields[key] = field;
      }
    }
    return { message: lineKey ? (map[lineKey] as string) : JSON.stringify(map), fields };
  }
  if (value.arrayValue?.values && value.arrayValue.values.length > 0) {
    return { message: JSON.stringify(decodeAny(value)) };
  }
  if (value.bytesValue !== undefined) {
    return { rejected: "a body of bytes" };
  }
  if (typeof eventName === "string" && eventName.length > 0) {
    return { message: eventName };
  }
  return { rejected: "no body" };
}

/** `losses` is told of every record that does not become a row. */
export function mapOtlpJson(payload: unknown, losses?: Losses): LogEvent[] {
  if (!payload || typeof payload !== "object") {
    throw new Error("Expected an OTLP JSON object");
  }
  const root = payload as Record<string, unknown>;
  const resourceLogs = root.resourceLogs;
  if (!Array.isArray(resourceLogs)) {
    throw new Error("resourceLogs is required");
  }
  const events: LogEvent[] = [];
  const skipResource = new Set(["service.name", "host.name"]);
  for (const rl of resourceLogs) {
    if (!rl || typeof rl !== "object") {
      continue;
    }
    const resource = (rl as Record<string, unknown>).resource as
      | { attributes?: Attr[] }
      | undefined;
    const service = attrString(resource?.attributes, "service.name") ?? "otlp";
    const host = attrString(resource?.attributes, "host.name");
    const resourceAttrs = attrRecord(resource?.attributes, skipResource);
    const scopeLogs = (rl as Record<string, unknown>).scopeLogs;
    if (!Array.isArray(scopeLogs)) {
      continue;
    }
    for (const sl of scopeLogs) {
      if (!sl || typeof sl !== "object") {
        continue;
      }
      const logRecords = (sl as Record<string, unknown>).logRecords;
      if (!Array.isArray(logRecords)) {
        continue;
      }
      // For most logging libraries the scope is the logger: the class or module that wrote the line.
      const scope = (sl as Record<string, unknown>).scope as { name?: unknown } | undefined;
      const scopeName =
        typeof scope?.name === "string" && scope.name.length > 0 ? scope.name : undefined;
      for (const rec of logRecords) {
        if (!rec || typeof rec !== "object") {
          continue;
        }
        const row = rec as Record<string, unknown>;
        const body = readBody(row.body, row.eventName);
        if ("rejected" in body) {
          losses?.reject(body.rejected);
          continue;
        }
        const message = body.message;
        const severityText = typeof row.severityText === "string" ? row.severityText : undefined;
        const severityNumber =
          typeof row.severityNumber === "number" ? row.severityNumber : undefined;
        // Order is what the 50-key cap keeps: the record's own attributes with
        // the frames read from its stack, then a map body's fields, then its
        // trace and span ids, then the logger's name, then the resource's.
        const attrs =
          liftException(attrRecord(row.attributes as Attr[] | undefined, new Set())) ?? {};
        // A map body's fields count with the record's own attributes, after them.
        for (const [key, value] of Object.entries(body.fields ?? {})) {
          if (!(key in attrs)) {
            attrs[key] = value;
          }
        }
        const traceId = otlpIdHex(row.traceId);
        const spanId = otlpIdHex(row.spanId);
        if (traceId && attrs.trace_id === undefined) {
          attrs.trace_id = traceId;
        }
        if (spanId && attrs.span_id === undefined) {
          attrs.span_id = spanId;
        }
        if (scopeName && attrs[scopeNameKey] === undefined) {
          attrs[scopeNameKey] = scopeName;
        }
        for (const [key, value] of Object.entries(resourceAttrs)) {
          if (!(key in attrs)) {
            attrs[key] = value;
          }
        }
        const lifted = liftIdentities(
          liftException(Object.keys(attrs).length > 0 ? attrs : undefined),
        );
        // The event's own time; else when a collector first saw it; else now.
        const ts =
          tsFromNano(row.timeUnixNano as string | number | undefined) ??
          tsFromNano(row.observedTimeUnixNano as string | number | undefined) ??
          new Date().toISOString();
        events.push({
          ts,
          service,
          host,
          level: mapSeverity(severityText, severityNumber),
          message,
          attrs: lifted,
        });
      }
    }
  }
  return events;
}

function attrValue(value: unknown): Attr["value"] {
  if (typeof value === "boolean") {
    return { boolValue: value };
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isInteger(value)) {
      return { intValue: value };
    }
    return { doubleValue: value };
  }
  return { stringValue: String(value) };
}

/** Inverse of `mapOtlpJson` for load/e2e clients. */
export function toOtlpJson(events: LogEvent[]): object {
  const groups = new Map<string, LogEvent[]>();
  for (const event of events) {
    const key = `${event.service}\0${event.host ?? ""}`;
    const list = groups.get(key);
    if (list) {
      list.push(event);
    } else {
      groups.set(key, [event]);
    }
  }
  return {
    resourceLogs: [...groups.values()].map((group) => {
      const first = group[0];
      if (!first) {
        throw new Error("empty OTLP resource group");
      }
      const resourceAttrs: Attr[] = [
        { key: "service.name", value: { stringValue: first.service } },
      ];
      if (first.host) {
        resourceAttrs.push({
          key: "host.name",
          value: { stringValue: first.host },
        });
      }
      return {
        resource: { attributes: resourceAttrs },
        scopeLogs: [
          {
            logRecords: group.map((event) => {
              const attributes: Attr[] = [];
              if (event.attrs) {
                for (const [key, value] of Object.entries(event.attrs)) {
                  attributes.push({ key, value: attrValue(value) });
                }
              }
              return {
                timeUnixNano: `${BigInt(Date.parse(event.ts)) * 1_000_000n}`,
                severityNumber: otlpSeverityNumber[event.level],
                severityText: event.level.toUpperCase(),
                body: { stringValue: event.message },
                attributes,
              };
            }),
          },
        ],
      };
    }),
  };
}
