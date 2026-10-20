import type { Context } from "hono";
import { insertMetricPoints } from "./metrics";
import {
  InvalidProbeError,
  parseProbeRequest,
  probeToMetricPoint,
  probesIngestBody,
  pullProbeUp,
  type ProbeSample,
} from "../shared/probe";
import { incMetric } from "../metrics";
import { InsertBackpressureError } from "./backpressure";
import { insertErrorMessage, MAX_BATCH, MAX_BODY_BYTES } from "./index";
import { applyResults } from "./checks";
import type { PushResult } from "../alerts/push";
import { parsePushName } from "../shared/push";

/**
 * An attached probe is also a push monitor's result (#177): `up` 1 is ok, 0 is a fail, and
 * `check` names the monitor (its `service` when it has no check). A pulled one is not.
 */
export function probeResult(sample: ProbeSample): PushResult | null {
  const name = parsePushName(sample.check || sample.service);
  if (sample.source !== "attach" || typeof name !== "string") {
    return null;
  }
  return {
    monitor: name,
    status: sample.up === 1 ? "ok" : "fail",
    message: "",
    value: null,
    unit: null,
    host: sample.host,
    service: sample.service,
    ts: sample.ts,
    exit_code: null,
    duration_ms: null,
    via: "probes",
    from: sample.host,
  };
}

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

async function resolveProbe(
  row: unknown,
  pullAllowed: boolean,
): Promise<ProbeSample> {
  const parsed = parseProbeRequest(row, { pullAllowed });
  switch (parsed.mode) {
    case "attach":
      return parsed.sample;
    case "pull": {
      const up = await pullProbeUp(parsed.sample.target);
      return { ...parsed.sample, up };
    }
    default: {
      const _exhaustive: never = parsed;
      return _exhaustive;
    }
  }
}

export async function ingestProbesRoute(c: Context): Promise<Response> {
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
    return c.json({ error: "Expected a probe or a non-empty array" }, 400);
  }
  if (raw.length > MAX_BATCH) {
    return c.json({ error: `Batch too large (max ${MAX_BATCH})` }, 400);
  }

  const samples: ProbeSample[] = [];
  try {
    for (const row of raw) {
      samples.push(await resolveProbe(row, single));
    }
  } catch (err) {
    const message =
      err instanceof InvalidProbeError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Invalid probe";
    return c.json({ error: message }, 400);
  }

  try {
    const ingested = await insertMetricPoints(samples.map(probeToMetricPoint));
    incMetric("ingest_metrics", ingested);
    const results = samples.map(probeResult).filter((r): r is PushResult => r !== null);
    // `up` is stored either way; a result a monitor cannot take says why beside it.
    const read = results.length > 0 ? await applyResults(results, Date.now()) : null;
    const body = probesIngestBody(single, samples, ingested);
    return c.json(read && !read.ok ? { ...body, monitor_error: read.error } : body);
  } catch (err) {
    if (err instanceof InsertBackpressureError) {
      return c.json({ error: "ClickHouse is busy" }, 429, {
        "retry-after": "1",
      });
    }
    return c.json({ error: insertErrorMessage(err) }, 503);
  }
}
