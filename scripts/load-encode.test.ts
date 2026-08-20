import { describe, expect, test } from "bun:test";
import { mapOtlpJson } from "../src/ingest/otlp";
import { decodeOtlpProtobuf } from "../src/ingest/otlp-protobuf";
import { parseSyslog3164 } from "../src/ingest/syslog-parse";
import { fakeLogEvent } from "../src/shared/fake-event";
import { MAX_BODY_BYTES } from "../src/ingest";
import { encodeLoadBatch } from "./load-encode";

const now = Date.UTC(2026, 7, 15, 12, 0, 0);

function events(n: number) {
  return Array.from({ length: n }, (_, i) =>
    fakeLogEvent({ i, n, now, windowMs: 60 * 60 * 1000, marker: "load-mix" }),
  );
}

describe("encodeLoadBatch", () => {
  test("json is a parseable array", () => {
    const batch = events(3);
    const encoded = encodeLoadBatch("json", batch);
    expect(encoded.transport).toBe("http");
    if (encoded.transport !== "http") {
      return;
    }
    expect(encoded.path).toBe("/api/ingest");
    expect(encoded.contentType).toBe("application/json");
    expect(JSON.parse(String(encoded.body))).toEqual(batch);
  });

  test("ndjson is one event per line", () => {
    const batch = events(3);
    const encoded = encodeLoadBatch("ndjson", batch);
    if (encoded.transport !== "http") {
      throw new Error("expected http");
    }
    expect(encoded.contentType).toBe("application/x-ndjson");
    const rows = String(encoded.body)
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    expect(rows).toEqual(batch);
  });

  test("otlp json round-trips through the mapper", () => {
    const batch = events(4);
    const encoded = encodeLoadBatch("otlp-json", batch);
    if (encoded.transport !== "http") {
      throw new Error("expected http");
    }
    expect(encoded.path).toBe("/v1/logs");
    const mapped = mapOtlpJson(JSON.parse(String(encoded.body)));
    expect(mapped.map((event) => event.message).sort()).toEqual(
      batch.map((event) => event.message).sort(),
    );
    expect(mapped.map((event) => event.service).sort()).toEqual(
      batch.map((event) => event.service).sort(),
    );
  });

  test("otlp protobuf round-trips through decode + mapper", () => {
    const batch = events(2);
    const encoded = encodeLoadBatch("otlp-protobuf", batch);
    if (encoded.transport !== "http") {
      throw new Error("expected http");
    }
    expect(encoded.contentType).toBe("application/x-protobuf");
    expect(encoded.body).toBeInstanceOf(Uint8Array);
    const mapped = mapOtlpJson(
      decodeOtlpProtobuf(encoded.body as Uint8Array),
    );
    expect(mapped).toHaveLength(2);
    expect(mapped.map((event) => event.message).sort()).toEqual(
      batch.map((event) => event.message).sort(),
    );
  });

  test("syslog datagrams parse back to the same service and message", () => {
    const batch = events(2);
    const encoded = encodeLoadBatch("syslog", batch);
    if (encoded.transport !== "udp") {
      throw new Error("expected udp");
    }
    expect(encoded.datagrams).toHaveLength(2);
    const parsed = encoded.datagrams.map((packet) =>
      parseSyslog3164(packet, new Date(now)),
    );
    expect(parsed[0]?.service).toBe(batch[0]?.service);
    expect(parsed[0]?.host).toBe(batch[0]?.host);
    expect(parsed[0]?.message).toBe(batch[0]?.message);
    expect(parsed[1]?.message).toBe(batch[1]?.message);
  });

  test("a 500-event OTLP JSON batch stays under the ingest body cap", () => {
    const encoded = encodeLoadBatch("otlp-json", events(500));
    if (encoded.transport !== "http") {
      throw new Error("expected http");
    }
    const bytes =
      typeof encoded.body === "string"
        ? encoded.body.length
        : encoded.body.byteLength;
    expect(bytes).toBeLessThan(MAX_BODY_BYTES);
  });
});
