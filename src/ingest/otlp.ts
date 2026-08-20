import { otlpIdHex } from "../shared/ids";
import type { LogEvent, LogLevel } from "../shared/log-event";
import { levels } from "../shared/log-event";

const otlpSeverityNumber: Record<LogLevel, number> = {
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  fatal: 21,
};

type Attr = {
  key?: string;
  value?: {
    stringValue?: string;
    intValue?: string | number;
    doubleValue?: number;
    boolValue?: boolean;
  };
};

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
    if (attr.value.stringValue !== undefined) {
      out[attr.key] = attr.value.stringValue;
    } else if (attr.value.intValue !== undefined) {
      out[attr.key] = Number(attr.value.intValue);
    } else if (attr.value.doubleValue !== undefined) {
      out[attr.key] = attr.value.doubleValue;
    } else if (attr.value.boolValue !== undefined) {
      out[attr.key] = attr.value.boolValue;
    }
  }
  return out;
}

function mapSeverity(text: string | undefined, number: number | undefined): LogLevel {
  const lower = (text ?? "").toLowerCase();
  if (levels.includes(lower as LogLevel)) {
    return lower as LogLevel;
  }
  if (lower.includes("fatal") || lower.includes("emerg") || lower.includes("panic")) {
    return "fatal";
  }
  if (lower.includes("err")) {
    return "error";
  }
  if (lower.includes("warn")) {
    return "warn";
  }
  if (lower.includes("debug") || lower.includes("trace")) {
    return "debug";
  }
  if (number === undefined || Number.isNaN(number)) {
    return "info";
  }
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

function bodyMessage(body: unknown): string {
  if (!body || typeof body !== "object") {
    return "";
  }
  const rec = body as Record<string, unknown>;
  if (typeof rec.stringValue === "string") {
    return rec.stringValue;
  }
  return "";
}

export function mapOtlpJson(payload: unknown): LogEvent[] {
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
      for (const rec of logRecords) {
        if (!rec || typeof rec !== "object") {
          continue;
        }
        const row = rec as Record<string, unknown>;
        const message = bodyMessage(row.body);
        if (message.length === 0) {
          continue;
        }
        const severityText = typeof row.severityText === "string" ? row.severityText : undefined;
        const severityNumber =
          typeof row.severityNumber === "number" ? row.severityNumber : undefined;
        const logAttrs = attrRecord(row.attributes as Attr[] | undefined, new Set());
        const attrs = { ...resourceAttrs, ...logAttrs };
        const traceId = otlpIdHex(row.traceId);
        const spanId = otlpIdHex(row.spanId);
        if (traceId && attrs.trace_id === undefined) {
          attrs.trace_id = traceId;
        }
        if (spanId && attrs.span_id === undefined) {
          attrs.span_id = spanId;
        }
        const ts =
          tsFromNano(row.timeUnixNano as string | number | undefined) ??
          new Date().toISOString();
        events.push({
          ts,
          service,
          host,
          level: mapSeverity(severityText, severityNumber),
          message,
          attrs: Object.keys(attrs).length > 0 ? attrs : undefined,
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
