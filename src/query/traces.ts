import type { Context } from "hono";
import { clickhouseQuery, toIsoTimestamp } from "../shared/clickhouse";
import { parseOtelSpanId, parseOtelTraceId } from "../shared/ids";
import {
  pickSlowestBranches,
  TRACE_SPAN_CAP,
  type Span,
  type SpanStatus,
  type TraceResponse,
} from "../shared/span";

type SpanRow = {
  trace_id: string;
  span_id: string;
  parent_span_id: string;
  service: string;
  name: string;
  ts: string;
  duration_ms: string | number;
  status: string;
  attrs: Record<string, string> | string;
};

type LinkRow = {
  span_id: string;
  parent_span_id: string;
  duration_ms: string | number;
};

function parseAttrs(raw: SpanRow["attrs"]): Record<string, string> {
  if (raw && typeof raw === "object") {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      out[key] = String(value);
    }
    return out;
  }
  if (typeof raw === "string" && raw.length > 0) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return parseAttrs(parsed as Record<string, string>);
      }
    } catch {
      return {};
    }
  }
  return {};
}

function parseStatus(value: string): SpanStatus {
  if (value === "ok" || value === "error") {
    return value;
  }
  return "unset";
}

function mapRow(row: SpanRow): Span {
  return {
    trace_id: row.trace_id,
    span_id: row.span_id,
    parent_span_id: row.parent_span_id,
    service: row.service,
    name: row.name,
    ts: toIsoTimestamp(row.ts),
    duration_ms: Number(row.duration_ms),
    status: parseStatus(row.status),
    attrs: parseAttrs(row.attrs),
  };
}

const spanSelect = `
  SELECT trace_id, span_id, parent_span_id, service, name, ts, duration_ms, status, attrs
  FROM spans
  WHERE tenant_id = 'default' AND trace_id = {id:String}
`;

async function fetchSpans(traceId: string, spanIds?: string[]): Promise<Span[]> {
  if (spanIds && spanIds.length === 0) {
    return [];
  }
  if (!spanIds) {
    const rows = await clickhouseQuery<SpanRow>(
      `${spanSelect} ORDER BY ts`,
      { id: traceId },
    );
    return rows.map(mapRow);
  }
  const params: Record<string, string> = { id: traceId };
  const placeholders = spanIds.map((spanId, i) => {
    const key = `s${i}`;
    params[key] = spanId;
    return `{${key}:String}`;
  });
  const rows = await clickhouseQuery<SpanRow>(
    `${spanSelect} AND span_id IN (${placeholders.join(",")}) ORDER BY ts`,
    params,
  );
  return rows.map(mapRow);
}

export function requireTraceId(raw: string): string | null {
  return parseOtelTraceId(raw);
}

export function requireSpanId(raw: string): string | null {
  return parseOtelSpanId(raw);
}

export async function searchTrace(traceId: string): Promise<TraceResponse> {
  const countRows = await clickhouseQuery<{ n: string | number }>(
    `SELECT count() AS n FROM spans WHERE tenant_id = 'default' AND trace_id = {id:String}`,
    { id: traceId },
  );
  const total = Number(countRows[0]?.n ?? 0);
  if (!Number.isFinite(total) || total <= 0) {
    return { spans: [], total: 0 };
  }
  if (total <= TRACE_SPAN_CAP) {
    return { spans: await fetchSpans(traceId), total };
  }
  const links = await clickhouseQuery<LinkRow>(
    `SELECT span_id, parent_span_id, duration_ms FROM spans
     WHERE tenant_id = 'default' AND trace_id = {id:String}`,
    { id: traceId },
  );
  const keep = pickSlowestBranches(
    links.map((row) => ({
      span_id: row.span_id,
      parent_span_id: row.parent_span_id,
      duration_ms: Number(row.duration_ms),
    })),
  );
  return { spans: await fetchSpans(traceId, [...keep]), total };
}

export async function tracesRoute(c: Context): Promise<Response> {
  const id = requireTraceId(c.req.param("trace_id") ?? "");
  if (!id) {
    return c.json({ error: "trace_id must be a 32-character hex id" }, 400);
  }
  const result = await searchTrace(id);
  return c.json(result);
}
