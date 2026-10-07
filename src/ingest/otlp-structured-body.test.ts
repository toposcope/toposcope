import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { flattenAttrs, flattenAttrsCounted, maxAttrKeysPerEvent } from "../shared/attrs";
import { mapOtlpJson } from "./otlp";
import { decodeOtlpProtobuf, encodeOtlpProtobuf } from "./otlp-protobuf";
import { Losses } from "./otlp-reply";
import { otlpLogsRoute } from "./otlp-route";

type AnyVal = Record<string, unknown>;
const str = (value: string): AnyVal => ({ stringValue: value });
const map = (fields: Record<string, AnyVal>): AnyVal => ({
  kvlistValue: { values: Object.entries(fields).map(([key, value]) => ({ key, value })) },
});
const attr = (key: string, value = "x") => ({ key, value: str(value) });

function request(records: object[], resource: object[] = []) {
  return {
    resourceLogs: [
      {
        resource: { attributes: [attr("service.name", "billing"), ...resource] },
        scopeLogs: [{ logRecords: records }],
      },
    ],
  };
}

/** The one row a one-record request stores. */
function row(record: object, resource: object[] = []) {
  const losses = new Losses();
  const events = mapOtlpJson(request([record], resource), losses);
  expect(losses.message()).toBe("");
  expect(events).toHaveLength(1);
  return { message: events[0]!.message, attrs: flattenAttrs(events[0]!.attrs) };
}

describe("an OTLP log body that is not a string", () => {
  test("a number or a boolean becomes its text", () => {
    expect(row({ body: { intValue: "42" } }).message).toBe("42");
    expect(row({ body: { doubleValue: 0.5 } }).message).toBe("0.5");
    expect(row({ body: { boolValue: false } }).message).toBe("false");
  });

  test("a map with a message gives that as the line and its other fields as attributes", () => {
    const stored = row({
      body: map({
        message: str("charge failed for order 1042"),
        order_id: { intValue: "1042" },
        customer: str("acme"),
        retry: { boolValue: true },
      }),
    });
    expect(stored.message).toBe("charge failed for order 1042");
    expect(stored.attrs).toEqual({ order_id: "1042", customer: "acme", retry: "true" });
  });

  test("msg is read the same way", () => {
    const stored = row({ body: map({ msg: str("charge failed"), order_id: str("1042") }) });
    expect(stored.message).toBe("charge failed");
    expect(stored.attrs).toEqual({ order_id: "1042" });
  });

  test("a map with neither keeps itself as JSON for the line, and still gives its fields", () => {
    const stored = row({ body: map({ event: str("charge.failed"), order_id: { intValue: "1042" } }) });
    expect(stored.message).toBe('{"event":"charge.failed","order_id":1042}');
    expect(stored.attrs).toEqual({ event: "charge.failed", order_id: "1042" });
  });

  test("a nested value is one attribute holding JSON, not a path", () => {
    const stored = row({
      body: map({ message: str("charge failed"), card: map({ brand: str("visa"), last4: str("4242") }) }),
    });
    expect(stored.attrs).toEqual({ card: '{"brand":"visa","last4":"4242"}' });
  });

  test("fields named like the row's own columns are not attributes, and are not reported as cut", () => {
    const events = mapOtlpJson(
      request([
        {
          body: map({
            msg: str("charge failed"),
            level: str("error"),
            ts: str("2026-01-01T00:00:00Z"),
            host: str("web-1"),
            order_id: str("1042"),
          }),
        },
      ]),
    );
    const flat = flattenAttrsCounted(events[0]!.attrs);
    expect(flat.attrs).toEqual({ order_id: "1042" });
    expect(flat.badName).toBe(0);
  });

  test("a list becomes its JSON text", () => {
    expect(row({ body: { arrayValue: { values: [str("a"), { intValue: "2" }] } } }).message).toBe(
      '["a",2]',
    );
  });

  test("the record's own attribute wins over a body field of the same name", () => {
    const stored = row({
      body: map({ message: str("charge failed"), order_id: str("from body") }),
      attributes: [attr("order_id", "from record")],
    });
    expect(stored.attrs.order_id).toBe("from record");
  });

  test("the cap counts the record's attributes, then the body's fields, then the trace id, then the resource", () => {
    const stored = row(
      {
        body: map({ message: str("charge failed"), body_a: str("x"), body_b: str("x") }),
        attributes: [attr("own_a"), attr("own_b")],
        traceId: "aabbccddeeff00112233445566778899",
      },
      Array.from({ length: 60 }, (_, i) => attr(`process.detail_${i}`)),
    );
    const keys = Object.keys(stored.attrs);
    expect(keys).toHaveLength(maxAttrKeysPerEvent);
    expect(keys.slice(0, 5)).toEqual(["own_a", "own_b", "body_a", "body_b", "trace_id"]);
  });

  test("protobuf carries a map body the same way", () => {
    const sent = request([{ body: map({ msg: str("charge failed"), order_id: { intValue: "1042" } }) }]);
    const events = mapOtlpJson(decodeOtlpProtobuf(encodeOtlpProtobuf(sent)));
    expect(events[0]!.message).toBe("charge failed");
    expect(flattenAttrs(events[0]!.attrs)).toEqual({ order_id: "1042" });
  });
});

describe("an OTLP log record with no body", () => {
  test("its event name is the line", () => {
    expect(row({ eventName: "cart.checkout", attributes: [attr("order_id", "1042")] })).toEqual({
      message: "cart.checkout",
      attrs: { order_id: "1042" },
    });
  });

  test("protobuf carries the event name too", () => {
    const events = mapOtlpJson(
      decodeOtlpProtobuf(encodeOtlpProtobuf(request([{ eventName: "cart.checkout" }]))),
    );
    expect(events[0]!.message).toBe("cart.checkout");
  });

  test("an empty string, an empty map and an empty list are no body", () => {
    for (const body of [str(""), { kvlistValue: { values: [] } }, { arrayValue: { values: [] } }]) {
      expect(row({ body, eventName: "cart.checkout" }).message).toBe("cart.checkout");
    }
  });

  test("with no event name either it is not stored, and the request is told", () => {
    const losses = new Losses();
    expect(mapOtlpJson(request([{ severityText: "INFO" }, { body: str("") }]), losses)).toEqual([]);
    expect(losses.message()).toBe("no body: 2 rejected");
  });

  test("a body of bytes is not stored, and the request is told", () => {
    const losses = new Losses();
    expect(mapOtlpJson(request([{ body: { bytesValue: "AAEC" } }]), losses)).toEqual([]);
    expect(losses.message()).toBe("a body of bytes: 1 rejected");
  });
});

describe("POST /v1/logs with bodies of every kind", () => {
  const app = new Hono();
  app.post("/v1/logs", otlpLogsRoute);
  let stored: string[];
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    stored = [];
    globalThis.fetch = Object.assign(
      async (_input: string | URL | Request, init?: RequestInit) => {
        stored.push(...String(init?.body ?? "").split("\n"));
        return new Response("");
      },
      { preconnect: realFetch.preconnect },
    );
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("stores the map, the number and the named event, and counts the one with nothing", async () => {
    const res = await app.request("/v1/logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        request([
          { body: map({ message: str("charge failed for order 1042"), order_id: str("1042") }) },
          { body: { intValue: "7" } },
          { eventName: "cart.checkout" },
          { severityText: "INFO" },
        ]),
      ),
    });
    expect(await res.json()).toEqual({
      ingested: 3,
      partialSuccess: { rejectedLogRecords: "1", errorMessage: "no body: 1 rejected" },
    });
    const rows = stored.map((line) => JSON.parse(line) as { message: string; attr_map: Record<string, string> });
    expect(rows.map((r) => r.message)).toEqual(["charge failed for order 1042", "7", "cart.checkout"]);
    // Found by a word in its message, filterable by a top-level field.
    expect(rows[0]!.attr_map.order_id).toBe("1042");
  });
});
