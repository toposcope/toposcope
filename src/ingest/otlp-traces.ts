import { flattenAttrs } from "../shared/attrs";
import { otlpIdHex } from "../shared/ids";
import { spanStatuses, type Span, type SpanStatus } from "../shared/span";

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

function nanoNumber(nano: string | number | undefined): number | undefined {
  if (nano === undefined) {
    return undefined;
  }
  const n = typeof nano === "number" ? nano : Number(nano);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function mapStatus(raw: unknown): SpanStatus {
  if (!raw || typeof raw !== "object") {
    return "unset";
  }
  const rec = raw as { code?: number | string; message?: string };
  const code = rec.code;
  if (code === 2 || code === "STATUS_CODE_ERROR" || code === "ERROR") {
    return "error";
  }
  if (code === 1 || code === "STATUS_CODE_OK" || code === "OK") {
    return "ok";
  }
  return "unset";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function mapOtlpTraces(payload: unknown): Span[] {
  if (!payload || typeof payload !== "object") {
    throw new Error("Expected an OTLP traces object");
  }
  const root = payload as Record<string, unknown>;
  const resourceSpans = root.resourceSpans ?? root.resource_spans;
  if (!Array.isArray(resourceSpans)) {
    throw new Error("resourceSpans is required");
  }
  const spans: Span[] = [];
  const skipResource = new Set(["service.name"]);
  for (const rs of resourceSpans) {
    const resourceBlock = asRecord(rs);
    if (!resourceBlock) {
      continue;
    }
    const resource = asRecord(resourceBlock.resource);
    const service =
      attrString(resource?.attributes as Attr[] | undefined, "service.name") ?? "otlp";
    const resourceAttrs = attrRecord(
      resource?.attributes as Attr[] | undefined,
      skipResource,
    );
    for (const ss of list(resourceBlock.scopeSpans ?? resourceBlock.scope_spans)) {
      const scope = asRecord(ss);
      if (!scope) {
        continue;
      }
      for (const rec of list(scope.spans)) {
        const row = asRecord(rec);
        if (!row) {
          continue;
        }
        const traceId = otlpIdHex(row.traceId ?? row.trace_id);
        const spanId = otlpIdHex(row.spanId ?? row.span_id);
        if (!traceId || !spanId) {
          continue;
        }
        const startNano = nanoNumber(
          (row.startTimeUnixNano ?? row.start_time_unix_nano) as string | number | undefined,
        );
        const endNano = nanoNumber(
          (row.endTimeUnixNano ?? row.end_time_unix_nano) as string | number | undefined,
        );
        const durationMs =
          startNano !== undefined && endNano !== undefined && endNano >= startNano
            ? (endNano - startNano) / 1_000_000
            : 0;
        const status = mapStatus(row.status);
        const statusRec = asRecord(row.status);
        const logAttrs = attrRecord(row.attributes as Attr[] | undefined, new Set());
        const attrs = { ...resourceAttrs, ...logAttrs };
        if (typeof statusRec?.message === "string" && statusRec.message.length > 0) {
          attrs["status.message"] = statusRec.message;
        }
        const name = typeof row.name === "string" && row.name.length > 0 ? row.name : "span";
        spans.push({
          trace_id: traceId,
          span_id: spanId,
          parent_span_id: otlpIdHex(row.parentSpanId ?? row.parent_span_id) ?? "",
          service,
          name,
          ts: tsFromNano(startNano) ?? new Date().toISOString(),
          duration_ms: durationMs,
          status,
          attrs: flattenAttrs(attrs),
        });
      }
    }
  }
  return spans;
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

function statusCode(status: SpanStatus): number {
  if (status === "error") {
    return 2;
  }
  if (status === "ok") {
    return 1;
  }
  return 0;
}

/** Inverse of `mapOtlpTraces` for load/e2e clients. */
export function toOtlpTracesJson(spans: Span[]): object {
  const groups = new Map<string, Span[]>();
  for (const span of spans) {
    const list = groups.get(span.service);
    if (list) {
      list.push(span);
    } else {
      groups.set(span.service, [span]);
    }
  }
  return {
    resourceSpans: [...groups.values()].map((group) => {
      const first = group[0];
      if (!first) {
        throw new Error("empty OTLP resource group");
      }
      return {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: first.service } }],
        },
        scopeSpans: [
          {
            spans: group.map((span) => {
              const startMs = Date.parse(span.ts);
              const attributes: Attr[] = [];
              for (const [key, value] of Object.entries(span.attrs)) {
                if (key === "status.message") {
                  continue;
                }
                attributes.push({ key, value: attrValue(value) });
              }
              const status: { code: number; message?: string } = {
                code: statusCode(span.status),
              };
              if (span.attrs["status.message"]) {
                status.message = span.attrs["status.message"];
              }
              return {
                traceId: span.trace_id,
                spanId: span.span_id,
                parentSpanId: span.parent_span_id,
                name: span.name,
                startTimeUnixNano: `${BigInt(startMs) * 1_000_000n}`,
                endTimeUnixNano: `${BigInt(startMs) * 1_000_000n + BigInt(Math.round(span.duration_ms * 1_000_000))}`,
                attributes,
                status,
              };
            }),
          },
        ],
      };
    }),
  };
}

export function isSpanStatus(value: string): value is SpanStatus {
  return (spanStatuses as readonly string[]).includes(value);
}
