import type { Context } from "hono";
import { incMetric } from "../metrics";
import {
  InsertBackpressureError,
  insertErrorMessage,
  insertEvents,
  MAX_BATCH,
  MAX_BODY_BYTES,
} from "./index";
import { mapOtlpJson } from "./otlp";
import { decodeOtlpProtobuf, isOtlpProtobufContentType } from "./otlp-protobuf";

function ingestFail(c: Context, err: unknown): Response {
  if (err instanceof InsertBackpressureError) {
    return c.json({ error: "ClickHouse is busy" }, 429, {
      "retry-after": "1",
    });
  }
  return c.json({ error: insertErrorMessage(err) }, 503);
}

export async function otlpLogsRoute(c: Context): Promise<Response> {
  let buf = new Uint8Array(await c.req.arrayBuffer());
  if (c.req.header("content-encoding") === "gzip") {
    buf = new Uint8Array(Bun.gunzipSync(buf));
  }
  if (buf.byteLength > MAX_BODY_BYTES) {
    return c.json({ error: `Body too large (max ${MAX_BODY_BYTES} bytes)` }, 413);
  }
  if (buf.byteLength === 0) {
    return c.json({ error: "Empty body" }, 400);
  }
  let payload: unknown;
  try {
    if (isOtlpProtobufContentType(c.req.header("content-type"))) {
      payload = decodeOtlpProtobuf(buf);
    } else {
      payload = JSON.parse(new TextDecoder().decode(buf).trim());
    }
  } catch {
    return c.json(
      {
        error: isOtlpProtobufContentType(c.req.header("content-type"))
          ? "Invalid OTLP protobuf body"
          : "Invalid JSON body",
      },
      400,
    );
  }
  let events;
  try {
    events = mapOtlpJson(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid OTLP payload";
    return c.json({ error: message }, 400);
  }
  if (events.length > MAX_BATCH) {
    return c.json({ error: `Batch too large (max ${MAX_BATCH})` }, 400);
  }
  try {
    const ingested = await insertEvents(events);
    incMetric("otlp_events", ingested);
    incMetric("ingest_events", ingested);
    return c.json({ ingested });
  } catch (err) {
    return ingestFail(c, err);
  }
}
