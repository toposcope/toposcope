import { describe, expect, test } from "bun:test";
import { requireSpanId, requireTraceId } from "./traces";

describe("requireTraceId", () => {
  test("accepts 32 hex and rejects aliases", () => {
    expect(requireTraceId("AABBCCDDEEFF00112233445566778899")).toBe(
      "aabbccddeeff00112233445566778899",
    );
    expect(requireTraceId("req-foo")).toBeNull();
    expect(requireTraceId("e".repeat(32))).toBe("e".repeat(32));
    expect(requireTraceId("0".repeat(32))).toBeNull();
    expect(requireTraceId("aabbccddeeff0011")).toBeNull();
  });
});

describe("requireSpanId", () => {
  test("accepts 16 hex only", () => {
    expect(requireSpanId("1122334455667788")).toBe("1122334455667788");
    expect(requireSpanId("aabbccddeeff00112233445566778899")).toBeNull();
    expect(requireSpanId("0".repeat(16))).toBeNull();
  });
});
