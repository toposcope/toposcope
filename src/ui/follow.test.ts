import { describe, expect, test } from "bun:test";
import { FOLLOW_MS, followQuery, followWindow, truncateFollowToken } from "./follow";

describe("followQuery", () => {
  test("replaces q with one quoted token", () => {
    expect(followQuery("request_id", "abc")).toBe("request_id:abc");
    expect(followQuery("path", "/v1/a b")).toBe('path:"/v1/a b"');
  });
});

describe("followWindow", () => {
  test("pins custom ±5m around the row", () => {
    const ts = "2026-08-16T12:00:00.000Z";
    const window = followWindow(ts);
    expect(window).not.toBeNull();
    if (!window) {
      throw new Error("expected a follow window");
    }
    expect(window.to.getTime() - window.from.getTime()).toBe(FOLLOW_MS * 2);
    expect(window?.from.toISOString()).toBe("2026-08-16T11:55:00.000Z");
    expect(window?.to.toISOString()).toBe("2026-08-16T12:05:00.000Z");
  });
});

describe("truncateFollowToken", () => {
  test("keeps short tokens and ellipsizes long ones", () => {
    expect(truncateFollowToken("request_id:abc")).toBe("request_id:abc");
    expect(truncateFollowToken("request_id:0123456789abcdef0123456789abcdef", 20)).toBe(
      "request_id:01234567…",
    );
  });
});
