import { describe, expect, test } from "bun:test";
import {
  canFollowField,
  followScanRole,
  isIdShapedValue,
  isOtelTraceId,
  joinTraceRef,
  otlpIdHex,
  parseOtelSpanId,
  parseOtelTraceId,
  pickTraceId,
} from "./ids";

describe("isIdShapedValue", () => {
  test("accepts UUID, long hex, prefixed ids, and ULID", () => {
    expect(isIdShapedValue("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isIdShapedValue("0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isIdShapedValue("0123456789abcdef")).toBe(true);
    expect(isIdShapedValue("usr_8f3a1c")).toBe(true);
    expect(isIdShapedValue("req-abc123")).toBe(true);
    expect(isIdShapedValue("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(true);
  });

  test("rejects chart-shaped and short values", () => {
    expect(isIdShapedValue("500")).toBe(false);
    expect(isIdShapedValue("u-5")).toBe(false);
    expect(isIdShapedValue("req-1")).toBe(false);
    expect(isIdShapedValue("0123456789abcde")).toBe(false);
    expect(isIdShapedValue("/v1/items")).toBe(false);
  });
});

describe("pickTraceId", () => {
  test("prefers trace_id then aliases", () => {
    expect(pickTraceId({ request_id: "r", req_id: "q" })).toBe("r");
    expect(pickTraceId({ trace_id: "t", request_id: "r" })).toBe("t");
    expect(pickTraceId({ traceid: "tid" })).toBe("tid");
    expect(pickTraceId({ path: "/v1" })).toBe("");
  });
});

describe("otlpIdHex", () => {
  test("keeps JSON hex and decodes protobuf bytes", () => {
    expect(otlpIdHex("aabbccddeeff0011")).toBe("aabbccddeeff0011");
    expect(otlpIdHex("0".repeat(32))).toBeUndefined();
    const hex = "aabbccddeeff00112233445566778899";
    expect(otlpIdHex(Buffer.from(hex, "hex").toString("base64"))).toBe(hex);
    expect(otlpIdHex(Uint8Array.from(Buffer.from("aabbccddeeff0011", "hex")))).toBe(
      "aabbccddeeff0011",
    );
  });
});

describe("canFollowField", () => {
  test("lookup or id-shaped attrs; never core columns", () => {
    expect(canFollowField("request_id", "not-an-id", "lookup")).toBe(true);
    expect(canFollowField("request_id", "0123456789abcdef0123456789abcdef", undefined)).toBe(
      true,
    );
    expect(canFollowField("status", "500", undefined)).toBe(false);
    expect(canFollowField("service", "usr_8f3a1c", undefined)).toBe(false);
    expect(canFollowField("ts", "2026-01-01T00:00:00.000Z", "lookup")).toBe(false);
    expect(followScanRole(undefined)).toBe("chart");
    expect(followScanRole("ignore")).toBe("ignore");
  });
});

describe("parseOtelTraceId / parseOtelSpanId", () => {
  test("accepts hex width and rejects zeros and junk", () => {
    const trace = "AABBCCDDEEFF00112233445566778899";
    expect(parseOtelTraceId(trace)).toBe(trace.toLowerCase());
    expect(isOtelTraceId(trace)).toBe(true);
    expect(parseOtelTraceId("0".repeat(32))).toBeNull();
    expect(parseOtelTraceId("req-abc123")).toBeNull();
    expect(parseOtelTraceId("aabbccddeeff0011")).toBeNull();
    expect(parseOtelSpanId("1122334455667788")).toBe("1122334455667788");
    expect(parseOtelSpanId("0".repeat(16))).toBeNull();
    expect(parseOtelSpanId(trace)).toBeNull();
  });
});

describe("joinTraceRef", () => {
  test("takes the first 32-hex alias and skips junk", () => {
    const hex = "aabbccddeeff00112233445566778899";
    expect(joinTraceRef({ request_id: "r", trace_id: hex.toUpperCase() })).toEqual({
      key: "trace_id",
      value: hex,
    });
    expect(joinTraceRef({ trace_id: "req-1", request_id: hex })).toEqual({
      key: "request_id",
      value: hex,
    });
    expect(joinTraceRef({ request_id: "req-abc123" })).toBeNull();
    expect(joinTraceRef({ path: "/v1" })).toBeNull();
  });
});
