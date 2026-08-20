import type { Context } from "hono";
import { incMetric } from "../metrics";
import {
  clickhouseInsertJsonEachRow,
  toClickHouseDateTime,
} from "../shared/clickhouse";
import type { ProfileSample } from "../shared/profile";
import { InsertBackpressureError, withInsertSlot } from "./backpressure";
import {
  insertErrorMessage,
  MAX_BATCH,
  MAX_BODY_BYTES,
} from "./index";
import { isOtlpProtobufContentType } from "./otlp-protobuf";
import { mapOtlpProfiles } from "./otlp-profiles";
import { decodeOtlpProfilesProtobuf } from "./otlp-profiles-protobuf";

function ingestFail(c: Context, err: unknown): Response {
  if (err instanceof InsertBackpressureError) {
    return c.json({ error: "ClickHouse is busy" }, 429, {
      "retry-after": "1",
    });
  }
  return c.json({ error: insertErrorMessage(err) }, 503);
}

async function insertProfileSamples(samples: ProfileSample[]): Promise<number> {
  if (samples.length === 0) {
    return 0;
  }
  return withInsertSlot(async () => {
    const body = samples
      .map((sample) =>
        JSON.stringify({
          tenant_id: "default",
          profile_id: sample.profile_id,
          service: sample.service,
          ts: toClickHouseDateTime(sample.ts),
          duration_ms: sample.duration_ms,
          sample_type: sample.sample_type,
          sample_unit: sample.sample_unit,
          period_type: sample.period_type,
          period_unit: sample.period_unit,
          trace_id: sample.trace_id,
          span_id: sample.span_id,
          frames: sample.frames,
          value: sample.value,
        }),
      )
      .join("\n");
    await clickhouseInsertJsonEachRow(body, "profile_samples");
    return samples.length;
  });
}

export async function otlpProfilesRoute(c: Context): Promise<Response> {
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
      payload = decodeOtlpProfilesProtobuf(buf);
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
  let mapped;
  try {
    mapped = mapOtlpProfiles(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid OTLP payload";
    return c.json({ error: message }, 400);
  }
  if (mapped.profileCount > MAX_BATCH) {
    return c.json({ error: `Batch too large (max ${MAX_BATCH})` }, 400);
  }
  try {
    const ingested = await insertProfileSamples(mapped.samples);
    incMetric("otlp_profile_samples", ingested);
    return c.json({ ingested });
  } catch (err) {
    return ingestFail(c, err);
  }
}
