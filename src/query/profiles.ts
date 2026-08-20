import type { Context } from "hono";
import { clickhouseQuery, toIsoTimestamp } from "../shared/clickhouse";
import {
  buildProfileResponse,
  emptyProfileResponse,
  type ProfileResponse,
  type ProfileSample,
} from "../shared/profile";
import { requireSpanId, requireTraceId } from "./traces";

type SampleRow = {
  profile_id: string;
  service: string;
  ts: string;
  duration_ms: string | number;
  sample_type: string;
  sample_unit: string;
  period_type: string;
  period_unit: string;
  trace_id: string;
  span_id: string;
  frames: string[] | string;
  value: string | number;
};

function parseFrames(raw: SampleRow["frames"]): string[] {
  if (Array.isArray(raw)) {
    return raw.map((frame) => String(frame)).filter((frame) => frame.length > 0);
  }
  if (typeof raw === "string" && raw.length > 0) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((frame) => String(frame)).filter((frame) => frame.length > 0);
      }
    } catch {
      return [];
    }
  }
  return [];
}

function mapRow(row: SampleRow): ProfileSample {
  return {
    profile_id: row.profile_id,
    service: row.service,
    ts: toIsoTimestamp(row.ts),
    duration_ms: Number(row.duration_ms),
    sample_type: row.sample_type,
    sample_unit: row.sample_unit,
    period_type: row.period_type,
    period_unit: row.period_unit,
    trace_id: row.trace_id,
    span_id: row.span_id,
    frames: parseFrames(row.frames),
    value: Number(row.value),
  };
}

export async function searchProfile(
  traceId: string,
  spanId: string,
): Promise<ProfileResponse> {
  const rows = await clickhouseQuery<SampleRow>(
    `
    SELECT
      profile_id, service, ts, duration_ms, sample_type, sample_unit,
      period_type, period_unit, trace_id, span_id, frames, value
    FROM profile_samples
    WHERE tenant_id = 'default'
      AND trace_id = {trace:String}
      AND span_id = {span:String}
    `,
    { trace: traceId, span: spanId },
  );
  if (rows.length === 0) {
    return emptyProfileResponse;
  }
  return buildProfileResponse(rows.map(mapRow));
}

export async function profilesRoute(c: Context): Promise<Response> {
  const traceId = requireTraceId(c.req.query("trace_id") ?? "");
  const spanId = requireSpanId(c.req.query("span_id") ?? "");
  if (!traceId || !spanId) {
    return c.json({ error: "trace_id must be 32-character hex and span_id 16-character hex" }, 400);
  }
  return c.json(await searchProfile(traceId, spanId));
}
