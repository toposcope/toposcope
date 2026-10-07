import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { maxAttrKeysPerEvent } from "../shared/attrs";
import { encodeOtlpProtobuf } from "./otlp-protobuf";
import { otlpProfilesRoute } from "./otlp-profiles-route";
import { toOtlpProfilesJson } from "./otlp-profiles";
import { encodeOtlpProfilesProtobuf } from "./otlp-profiles-protobuf";
import { decodeOtlpReply, Losses } from "./otlp-reply";
import { otlpLogsRoute } from "./otlp-route";
import { encodeOtlpTracesProtobuf } from "./otlp-traces-protobuf";
import { otlpTracesRoute } from "./otlp-traces-route";

const app = new Hono();
app.post("/v1/logs", otlpLogsRoute);
app.post("/v1/traces", otlpTracesRoute);
app.post("/v1/profiles", otlpProfilesRoute);

type Attr = { key: string; value: { stringValue: string } };
const attr = (key: string, value = "x"): Attr => ({ key, value: { stringValue: value } });

function logs(records: object[]) {
  return {
    resourceLogs: [
      {
        resource: { attributes: [attr("service.name", "billing")] },
        scopeLogs: [{ logRecords: records }],
      },
    ],
  };
}
const record = (message: string, attributes: Attr[] = []) => ({
  severityText: "ERROR",
  body: { stringValue: message },
  attributes,
});
const bodiless = { severityText: "ERROR", attributes: [attr("request_id", "r-1")] };

function traces(spans: object[]) {
  return {
    resourceSpans: [
      { resource: { attributes: [attr("service.name", "billing")] }, scopeSpans: [{ spans }] },
    ],
  };
}
const span = (id: string) => ({
  traceId: "aabbccddeeff00112233445566778899",
  spanId: id,
  name: "GET /pay",
  startTimeUnixNano: "1767225600000000000",
  endTimeUnixNano: "1767225600001000000",
});

const postJson = (path: string, body: unknown) =>
  Promise.resolve(
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
const postProtobuf = (path: string, body: Uint8Array) =>
  Promise.resolve(
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/x-protobuf" },
      body: Buffer.from(body),
    }),
  );
const bytes = async (res: Response) => new Uint8Array(await res.arrayBuffer());

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

describe("a batch with one bodiless log record", () => {
  const batch = logs([record("charge failed"), bodiless, record("refund failed")]);

  test("a JSON request stores the rest and its JSON reply counts one rejected, with the reason", async () => {
    const res = await postJson("/v1/logs", batch);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({
      ingested: 2,
      partialSuccess: { rejectedLogRecords: "1", errorMessage: "no body: 1 rejected" },
    });
    expect(stored).toEqual({ logs: 2 });
  });

  test("a protobuf request gets the same in protobuf", async () => {
    const res = await postProtobuf("/v1/logs", encodeOtlpProtobuf(batch));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-protobuf");
    expect(decodeOtlpReply(await bytes(res))).toEqual({
      rejected: 1,
      errorMessage: "no body: 1 rejected",
    });
    expect(stored).toEqual({ logs: 2 });
  });
});

describe("a request that lost nothing", () => {
  test("JSON keeps the reply it always had", async () => {
    const res = await postJson("/v1/logs", logs([record("charge failed")]));
    expect(await res.json()).toEqual({ ingested: 1 });
  });

  test("protobuf gets an empty protobuf message, which is a full success", async () => {
    const res = await postProtobuf("/v1/logs", encodeOtlpProtobuf(logs([record("charge failed")])));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-protobuf");
    const body = await bytes(res);
    expect(body.byteLength).toBe(0);
    expect(decodeOtlpReply(body)).toEqual({ rejected: 0, errorMessage: "" });
  });

  test("traces and profiles answer protobuf in protobuf too", async () => {
    const tracesRes = await postProtobuf(
      "/v1/traces",
      encodeOtlpTracesProtobuf(traces([span("1122334455667788")])),
    );
    expect(tracesRes.headers.get("content-type")).toBe("application/x-protobuf");
    expect((await bytes(tracesRes)).byteLength).toBe(0);

    const profilesRes = await postProtobuf(
      "/v1/profiles",
      encodeOtlpProfilesProtobuf(
        toOtlpProfilesJson([
          {
            service: "api",
            ts: "2026-01-01T00:00:00.000Z",
            duration_ms: 1,
            profile_id: "01".padStart(32, "0"),
            samples: [{ frames: ["main"], value: 1 }],
          },
        ]),
      ),
    );
    expect(profilesRes.status).toBe(200);
    expect(profilesRes.headers.get("content-type")).toBe("application/x-protobuf");
    expect(stored).toEqual({ spans: 1, profile_samples: 1 });
  });
});

describe("a record that was stored without all it was sent with", () => {
  test("attributes past the cap are a warning: nothing rejected, and it says so", async () => {
    const wide = Array.from({ length: maxAttrKeysPerEvent + 10 }, (_, i) => attr(`app_${i}`));
    const res = await postJson("/v1/logs", logs([record("charge failed", wide), record("fine")]));
    expect(await res.json()).toEqual({
      ingested: 2,
      partialSuccess: {
        rejectedLogRecords: "0",
        errorMessage: "attributes past the 50-attribute cap: cut on 1",
      },
    });
    expect(stored).toEqual({ logs: 2 });
  });

  test("an attribute under a name a row cannot hold is a warning too", async () => {
    const res = await postJson("/v1/logs", logs([record("charge failed", [attr("http-status", "500")])]));
    const body = (await res.json()) as { partialSuccess?: { errorMessage: string } };
    expect(body.partialSuccess?.errorMessage).toBe(
      "attributes under a name that cannot be stored: cut on 1",
    );
  });

  test("a span with no ids is rejected and the rest are stored", async () => {
    const res = await postJson(
      "/v1/traces",
      traces([span("1122334455667788"), { name: "no ids" }, span("2222334455667788")]),
    );
    expect(await res.json()).toEqual({
      ingested: 2,
      partialSuccess: { rejectedSpans: "1", errorMessage: "no trace id or span id: 1 rejected" },
    });
    expect(stored).toEqual({ spans: 2 });
  });
});

describe("a request that cannot be read", () => {
  test("keeps its 400, in JSON", async () => {
    const res = await postProtobuf("/v1/logs", new Uint8Array([0xff, 0xff, 0xff]));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid OTLP protobuf body" });
  });
});

describe("the one line of why", () => {
  test("names what was rejected first, then what was cut", () => {
    const losses = new Losses();
    losses.trim("attributes past the 50-attribute cap", 3);
    losses.reject("no body");
    losses.reject("no body");
    expect(losses.rejectedCount).toBe(2);
    expect(losses.message()).toBe(
      "no body: 2 rejected; attributes past the 50-attribute cap: cut on 3",
    );
  });

  test("is empty when nothing was lost, and never longer than 500 characters", () => {
    expect(new Losses().message()).toBe("");
    const losses = new Losses();
    for (let i = 0; i < 60; i++) {
      losses.reject(`reason number ${i} that is fairly long`);
    }
    expect(losses.message().length).toBe(500);
  });
});
