import type { Context } from "hono";
import * as v from "valibot";
import {
  clickhouseInsertJsonEachRow,
  toClickHouseDateTime,
} from "../shared/clickhouse";
import { incMetric } from "../metrics";
import { recordReceived } from "./received-ring";
import { flattenAttrs } from "../shared/attrs";
import { pickTraceId } from "../shared/ids";
import {
  parseIngestEvent,
  stampEvent,
  type LogEvent,
} from "../shared/log-event";
import { InsertBackpressureError, withInsertSlot } from "./backpressure";

export { InsertBackpressureError } from "./backpressure";

export const MAX_BATCH = 500;
export const MAX_BODY_BYTES = 1_000_000;

export async function insertEvents(events: LogEvent[]): Promise<number> {
  if (events.length === 0) {
    return 0;
  }
  return withInsertSlot(async () => {
    const body = events
      .map((event) => {
        const attr_map = flattenAttrs(event.attrs);
        return JSON.stringify({
          tenant_id: "default",
          ts: toClickHouseDateTime(event.ts),
          service: event.service,
          host: event.host ?? "",
          level: event.level,
          message: event.message,
          attrs: JSON.stringify(attr_map),
          attr_map,
          trace_id: pickTraceId(attr_map),
        });
      })
      .join("\n");
    await clickhouseInsertJsonEachRow(body);
    recordReceived(events.length);
    return events.length;
  });
}

export function insertErrorMessage(err: unknown): string {
  const message =
    err instanceof Error ? err.message : "ClickHouse insert failed";
  return message.slice(0, 500);
}

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

export async function ingestRoute(c: Context): Promise<Response> {
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength > MAX_BODY_BYTES) {
    return c.json({ error: `Body too large (max ${MAX_BODY_BYTES} bytes)` }, 413);
  }
  const text = new TextDecoder().decode(buf).trim();
  if (text.length === 0) {
    return c.json({ error: "Empty body" }, 400);
  }

  let rawEvents: unknown[];
  try {
    rawEvents = parseBody(text, c.req.header("content-type") ?? "");
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (rawEvents.length === 0) {
    return c.json({ error: "Expected a log event or a non-empty array" }, 400);
  }
  if (rawEvents.length > MAX_BATCH) {
    return c.json({ error: `Batch too large (max ${MAX_BATCH})` }, 400);
  }

  const events: LogEvent[] = [];
  for (const raw of rawEvents) {
    try {
      events.push(stampEvent(parseIngestEvent(raw)));
    } catch (err) {
      const message = v.isValiError(err)
        ? err.message
        : err instanceof Error
          ? err.message
          : "Invalid log event";
      return c.json({ error: message }, 400);
    }
  }

  try {
    const ingested = await insertEvents(events);
    incMetric("ingest_events", ingested);
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
