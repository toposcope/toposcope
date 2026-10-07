import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { LogEvent } from "../shared/log-event";
import type { Span } from "../shared/span";
import { ingestRoute, MAX_BATCH, MAX_OTLP_BATCH } from "./index";
import { toOtlpJson } from "./otlp";
import { otlpLogsRoute } from "./otlp-route";
import { toOtlpTracesJson } from "./otlp-traces";
import { otlpTracesRoute } from "./otlp-traces-route";

/** What an OpenTelemetry batch processor sends when its queue is full. */
const EXPORTER_DEFAULT_BATCH = 512;

const app = new Hono();
app.post("/api/ingest", ingestRoute);
app.post("/v1/logs", otlpLogsRoute);
app.post("/v1/traces", otlpTracesRoute);

function logs(count: number): LogEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    ts: "2026-01-01T00:00:00.000Z",
    service: "api",
    level: "error",
    message: `payment failed ${i}`,
  }));
}

function spans(count: number): Span[] {
  return Array.from({ length: count }, (_, i) => ({
    trace_id: "aabbccddeeff00112233445566778899",
    span_id: (i + 1).toString(16).padStart(16, "0"),
    parent_span_id: "",
    service: "api",
    name: "GET /pay",
    ts: "2026-01-01T00:00:00.000Z",
    duration_ms: 1,
    status: "ok",
    attrs: {},
  }));
}

const routes = [
  { path: "/v1/logs", table: "logs", payload: (count: number) => toOtlpJson(logs(count)) },
  { path: "/v1/traces", table: "spans", payload: (count: number) => toOtlpTracesJson(spans(count)) },
];

function post(path: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/** Rows each table was asked to store. ClickHouse itself is stubbed. */
let stored: Record<string, number>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  stored = {};
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const query = new URL(String(input)).searchParams.get("query") ?? "";
      const table = query.match(/^INSERT INTO (\w+) /)?.[1];
      if (!table) {
        throw new Error(`Unexpected fetch: ${String(input)}`);
      }
      stored[table] = (stored[table] ?? 0) + String(init?.body ?? "").split("\n").length;
      return new Response("");
    },
    { preconnect: realFetch.preconnect },
  );
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("OTLP record cap", () => {
  test.each(routes)("$path stores an exporter's default batch of 512", async ({ path, table, payload }) => {
    const res = await post(path, payload(EXPORTER_DEFAULT_BATCH));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ingested: EXPORTER_DEFAULT_BATCH });
    expect(stored).toEqual({ [table]: EXPORTER_DEFAULT_BATCH });
  });

  test.each(routes)("$path stores a batch at the cap", async ({ path, table, payload }) => {
    expect(MAX_OTLP_BATCH).toBe(1_000);
    const res = await post(path, payload(MAX_OTLP_BATCH));
    expect(res.status).toBe(200);
    expect(stored).toEqual({ [table]: MAX_OTLP_BATCH });
  });

  test.each(routes)("$path refuses one over the cap with a single 400 and stores nothing", async ({ path, payload }) => {
    const res = await post(path, payload(MAX_OTLP_BATCH + 1));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Batch too large (max 1000)" });
    expect(stored).toEqual({});
  });

  test("/api/ingest keeps 500", async () => {
    expect(MAX_BATCH).toBe(500);
    const res = await post("/api/ingest", logs(MAX_BATCH + 1));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Batch too large (max 500)" });
    expect(stored).toEqual({});
  });
});
