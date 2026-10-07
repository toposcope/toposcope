import type { Context } from "hono";
import {
  clickhouseInsertJsonEachRow,
  toClickHouseDateTime,
} from "../shared/clickhouse";
import { InvalidMetricError, parseMetricPoint } from "../shared/metric";
import { rememberMetricKinds } from "../shared/metric-kinds";
import { incMetric } from "../metrics";
import { InsertBackpressureError, withInsertSlot } from "./backpressure";
import { insertErrorMessage, MAX_BATCH } from "./index";
import { readOtlpBody } from "./otlp-body";
import { mapOtlpMetrics } from "./otlp-metrics";
import { decodeOtlpMetricsProtobuf } from "./otlp-metrics-protobuf";
import { isOtlpProtobufContentType } from "./otlp-protobuf";
import { Losses, otlpReply } from "./otlp-reply";
import { RunningTotals } from "./running-totals";

/** The last total of every series a stock exporter sends. It lives as long as the process. */
const runningTotals = new RunningTotals();

function parseNdjson(text: string): unknown[] {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  const rows: unknown[] = [];
  for (const line of lines) {
    rows.push(JSON.parse(line) as unknown);
  }
  return rows;
}

function parseBody(text: string, contentType: string): unknown[] {
  const ndjson =
    contentType.includes("application/x-ndjson") ||
    contentType.includes("application/ndjson");
  if (ndjson) {
    return parseNdjson(text);
  }
  try {
    const json: unknown = JSON.parse(text);
    if (Array.isArray(json)) {
      return json;
    }
    return [json];
  } catch {
    return parseNdjson(text);
  }
}

export async function insertMetricPoints(
  points: Array<{
    ts: string;
    name: string;
    value: number;
    labels: Record<string, string>;
  }>,
): Promise<number> {
  if (points.length === 0) {
    return 0;
  }
  return withInsertSlot(async () => {
    const body = points
      .map((point) =>
        JSON.stringify({
          tenant_id: "default",
          ts: toClickHouseDateTime(point.ts),
          name: point.name,
          value: point.value,
          labels: point.labels,
        }),
      )
      .join("\n");
    await clickhouseInsertJsonEachRow(body, "metrics");
    return points.length;
  });
}

function ingestFail(c: Context, err: unknown): Response {
  if (err instanceof InsertBackpressureError) {
    return c.json({ error: "ClickHouse is busy" }, 429, {
      "retry-after": "1",
    });
  }
  return c.json({ error: insertErrorMessage(err) }, 503);
}

function isOtlpMetricsJson(row: unknown): boolean {
  return (
    typeof row === "object" &&
    row !== null &&
    Array.isArray((row as Record<string, unknown>).resourceMetrics)
  );
}

/**
 * An OTLP metrics request. It is limited by its size and not by a count of
 * points: an exporter sends every series in one request and cannot split it.
 */
async function otlpMetrics(c: Context, payload: unknown): Promise<Response> {
  const losses = new Losses();
  let mapped;
  try {
    mapped = mapOtlpMetrics(payload, losses, runningTotals);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Invalid OTLP payload" }, 400);
  }
  try {
    // Kinds first: writing one twice is harmless, and a retry after a failure here stores no point twice.
    await rememberMetricKinds(mapped.kinds);
    const ingested = await insertMetricPoints(mapped.points);
    incMetric("ingest_metrics", ingested);
    return otlpReply(c, "metrics", ingested, losses);
  } catch (err) {
    return ingestFail(c, err);
  }
}

export async function ingestMetricsRoute(c: Context): Promise<Response> {
  const contentType = c.req.header("content-type") ?? "";
  const buf = await readOtlpBody(c);
  if (buf instanceof Response) {
    return buf;
  }
  if (isOtlpProtobufContentType(contentType)) {
    if (buf.byteLength === 0) {
      return c.json({ error: "Empty body" }, 400);
    }
    let payload: unknown;
    try {
      payload = decodeOtlpMetricsProtobuf(buf);
    } catch {
      return c.json({ error: "Invalid OTLP protobuf body" }, 400);
    }
    return otlpMetrics(c, payload);
  }
  const text = new TextDecoder().decode(buf).trim();
  if (text.length === 0) {
    return c.json({ error: "Empty body" }, 400);
  }

  let raw: unknown[];
  try {
    raw = parseBody(text, contentType);
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (raw.length === 1 && isOtlpMetricsJson(raw[0])) {
    return otlpMetrics(c, raw[0]);
  }

  if (raw.length === 0) {
    return c.json({ error: "Expected a metric point or a non-empty array" }, 400);
  }
  if (raw.length > MAX_BATCH) {
    return c.json({ error: `Batch too large (max ${MAX_BATCH})` }, 400);
  }

  const points = [];
  for (const row of raw) {
    try {
      points.push(parseMetricPoint(row));
    } catch (err) {
      const message =
        err instanceof InvalidMetricError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Invalid metric point";
      return c.json({ error: message }, 400);
    }
  }

  try {
    const ingested = await insertMetricPoints(points);
    incMetric("ingest_metrics", ingested);
    return c.json({ ingested });
  } catch (err) {
    return ingestFail(c, err);
  }
}
