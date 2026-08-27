import type { Context } from "hono";
import { incMetric } from "../metrics";
import {
  clickhouseInsertJsonEachRow,
  toClickHouseDateTime,
} from "../shared/clickhouse";
import type { Span } from "../shared/span";
import { InsertBackpressureError, withInsertSlot } from "./backpressure";
import {
  insertErrorMessage,
  MAX_BATCH,
} from "./index";
import { readOtlpBody } from "./otlp-body";
import { isOtlpProtobufContentType } from "./otlp-protobuf";
import { decodeOtlpTracesProtobuf } from "./otlp-traces-protobuf";
import { mapOtlpTraces } from "./otlp-traces";

function ingestFail(c: Context, err: unknown): Response {
  if (err instanceof InsertBackpressureError) {
    return c.json({ error: "ClickHouse is busy" }, 429, {
      "retry-after": "1",
    });
  }
  return c.json({ error: insertErrorMessage(err) }, 503);
}

async function insertSpans(spans: Span[]): Promise<number> {
  if (spans.length === 0) {
    return 0;
  }
  return withInsertSlot(async () => {
    const body = spans
      .map((span) =>
        JSON.stringify({
          tenant_id: "default",
          trace_id: span.trace_id,
          span_id: span.span_id,
          parent_span_id: span.parent_span_id,
          service: span.service,
          name: span.name,
          ts: toClickHouseDateTime(span.ts),
          duration_ms: span.duration_ms,
          status: span.status,
          attrs: span.attrs,
        }),
      )
      .join("\n");
    await clickhouseInsertJsonEachRow(body, "spans");
    return spans.length;
  });
}

export async function otlpTracesRoute(c: Context): Promise<Response> {
  const buf = await readOtlpBody(c);
  if (buf instanceof Response) {
    return buf;
  }
  if (buf.byteLength === 0) {
    return c.json({ error: "Empty body" }, 400);
  }
  let payload: unknown;
  try {
    if (isOtlpProtobufContentType(c.req.header("content-type"))) {
      payload = decodeOtlpTracesProtobuf(buf);
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
  let spans;
  try {
    spans = mapOtlpTraces(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid OTLP payload";
    return c.json({ error: message }, 400);
  }
  if (spans.length > MAX_BATCH) {
    return c.json({ error: `Batch too large (max ${MAX_BATCH})` }, 400);
  }
  try {
    const ingested = await insertSpans(spans);
    incMetric("otlp_spans", ingested);
    return c.json({ ingested });
  } catch (err) {
    return ingestFail(c, err);
  }
}
