import type { Context } from "hono";
import {
  clickhouseInsertJsonEachRow,
  toClickHouseDateTime,
} from "../shared/clickhouse";
import {
  InvalidChangeMarkError,
  marksIngestBody,
  marksToInsert,
  parseChangeMarkRequest,
  type ChangeMark,
} from "../shared/change-mark";
import { lookupChangeMarkStates } from "../query/marks";
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

function parseBody(
  text: string,
  contentType: string,
): { rows: unknown[]; single: boolean } {
  const ndjson =
    contentType.includes("application/x-ndjson") ||
    contentType.includes("application/ndjson");
  if (ndjson) {
    return { rows: parseNdjson(text), single: false };
  }
  try {
    const json: unknown = JSON.parse(text);
    if (Array.isArray(json)) {
      return { rows: json, single: false };
    }
    return { rows: [json], single: true };
  } catch {
    return { rows: parseNdjson(text), single: false };
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

  let parsedBody: { rows: unknown[]; single: boolean };
  try {
    parsedBody = parseBody(text, c.req.header("content-type") ?? "");
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const { rows: raw, single } = parsedBody;

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
    const existing = await lookupChangeMarkStates(
      parsed.filter((row) => row.idProvided).map((row) => row.mark.id),
    );
    const ingestedMarks = marksToInsert(parsed, existing);
    const ingested = await insertChangeMarks(ingestedMarks);
    incMetric("ingest_marks", ingested);
    return c.json(
      marksIngestBody(
        single,
        parsed.map((row) => row.mark.id),
        ingested,
      ),
    );
  } catch (err) {
    if (err instanceof InvalidChangeMarkError) {
      return c.json({ error: err.message }, 400);
    }
    if (err instanceof InsertBackpressureError) {
      return c.json({ error: "ClickHouse is busy" }, 429, {
        "retry-after": "1",
      });
    }
    return c.json({ error: insertErrorMessage(err) }, 503);
  }
}
