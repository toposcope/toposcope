import { describe, expect, test } from "bun:test";
import type { FollowOpened } from "../shared/follow-span";
import { followOnOpened, followQuery, truncateFollowToken } from "./follow";

const iso = (ms: number) => new Date(ms).toISOString();

describe("followQuery", () => {
  test("replaces q with one quoted token", () => {
    expect(followQuery("request_id", "abc")).toBe("request_id:abc");
    expect(followQuery("path", "/v1/a b")).toBe('path:"/v1/a b"');
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

describe("followOnOpened", () => {
  const opened: FollowOpened = {
    how: "span",
    fromMs: Date.parse("2026-10-14T09:12:03.000Z"),
    toMs: Date.parse("2026-10-15T06:20:42.000Z"),
  };
  const clock = {
    range: "custom",
    from: iso(opened.fromMs),
    to: iso(opened.toMs),
    live: false,
    explored: false,
  };
  test("on the opened window until the clock moves", () => {
    expect(followOnOpened(opened, clock)).toBe(true);
    expect(followOnOpened(opened, { ...clock, range: "7d" })).toBe(false);
    expect(followOnOpened(opened, { ...clock, live: true })).toBe(false);
    expect(followOnOpened(opened, { ...clock, explored: true })).toBe(false);
    expect(followOnOpened(opened, { ...clock, to: iso(opened.toMs + 1000) })).toBe(false);
  });
});
