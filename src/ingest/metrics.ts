import type { Context } from "hono";
import {
  clickhouseInsertJsonEachRow,
  toClickHouseDateTime,
} from "../shared/clickhouse";
import { InvalidMetricError, parseMetricPoint } from "../shared/metric";
import { incMetric } from "../metrics";
import { InsertBackpressureError, withInsertSlot } from "./backpressure";
import {
  insertErrorMessage,
  MAX_BATCH,
  MAX_BODY_BYTES,
} from "./index";

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

async function insertMetrics(
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

export async function ingestMetricsRoute(c: Context): Promise<Response> {
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength > MAX_BODY_BYTES) {
    return c.json({ error: `Body too large (max ${MAX_BODY_BYTES} bytes)` }, 413);
  }
  const text = new TextDecoder().decode(buf).trim();
  if (text.length === 0) {
    return c.json({ error: "Empty body" }, 400);
  }

  let raw: unknown[];
  try {
    raw = parseBody(text, c.req.header("content-type") ?? "");
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
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
    const ingested = await insertMetrics(points);
    incMetric("ingest_metrics", ingested);
    return c.json({ ingested });
  } catch (err) {
    if (err instanceof InsertBackpressureError) {
      return c.json({ error: "ClickHouse is busy" }, 429, {
        "retry-after": "1",
      });
    }
    return c.json({ error: insertErrorMessage(err) }, 503);
  }
}
