import type { Context } from "hono";
import {
  clickhouseInsertJsonEachRow,
  toClickHouseDateTime,
} from "../shared/clickhouse";
import {
  InvalidChangeMarkError,
  marksToInsert,
  parseChangeMarkRequest,
  type ChangeMark,
} from "../shared/change-mark";
import { lookupChangeMarkIds } from "../query/marks";
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

async function insertChangeMarks(marks: ChangeMark[]): Promise<number> {
  if (marks.length === 0) {
    return 0;
  }
  return withInsertSlot(async () => {
    const body = marks
      .map((mark) =>
        JSON.stringify({
          tenant_id: "default",
          ts: toClickHouseDateTime(mark.ts),
          kind: mark.kind,
          service: mark.service,
          title: mark.title,
          attrs: mark.attrs,
          id: mark.id,
          ...(mark.end_ts
            ? { end_ts: toClickHouseDateTime(mark.end_ts) }
            : { end_ts: null }),
        }),
      )
      .join("\n");
    await clickhouseInsertJsonEachRow(body, "change_marks");
    return marks.length;
  });
}

export async function ingestMarksRoute(c: Context): Promise<Response> {
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
    return c.json({ error: "Expected a change mark or a non-empty array" }, 400);
  }
  if (raw.length > MAX_BATCH) {
    return c.json({ error: `Batch too large (max ${MAX_BATCH})` }, 400);
  }

  const parsed = [];
  for (const row of raw) {
    try {
      parsed.push(parseChangeMarkRequest(row));
    } catch (err) {
      const message =
        err instanceof InvalidChangeMarkError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Invalid change mark";
      return c.json({ error: message }, 400);
    }
  }

  try {
    const existing = await lookupChangeMarkIds(
      parsed.filter((row) => row.idProvided).map((row) => row.mark.id),
    );
    const ingested = await insertChangeMarks(marksToInsert(parsed, existing));
    incMetric("ingest_marks", ingested);
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
