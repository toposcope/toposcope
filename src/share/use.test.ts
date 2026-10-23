import { beforeEach, describe, expect, test } from "bun:test";
import { drainUse, noteLimited, noteRead, noteRefused, pendingUse, resetShareUse, takeRead } from "./use";

const now = Date.parse("2026-10-23T12:00:00Z");

beforeEach(() => resetShareUse());

describe("a share's rate", () => {
  test("reads_per_minute deep, refilled at that rate", () => {
    for (let i = 0; i < 3; i++) {
      expect(takeRead("s1", 3, now)).toEqual({ ok: true });
    }
    expect(takeRead("s1", 3, now)).toEqual({ ok: false, retryAfter: 20 });
    expect(takeRead("s1", 3, now + 20_000)).toEqual({ ok: true });
    // Another share has its own bucket.
    expect(takeRead("s2", 3, now)).toEqual({ ok: true });
  });
});

describe("use rows", () => {
  test("one row a minute per share, and one per refusal; no viewer addresses", () => {
    noteRead("console", "https://admin.example.com", false, now);
    noteRead("console", "https://admin.example.com", true, now);
    noteLimited("console", undefined);
    noteRefused("console", "https://admin.example.com", "/share/v1/series", "this share cannot split by account_id", now);
    expect(pendingUse().get("console")).toEqual({ reads: 2, refused: 1, last_read_at: new Date(now).toISOString() });
    const rows = drainUse(now);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      service: "toposcope",
      level: "warn",
      attrs: { share: "console", status: "refused", reason: "this share cannot split by account_id" },
    });
    expect(rows[1]).toMatchObject({
      level: "warn",
      message: "share console: 1 reads, 1 cached, 1 refused, 1 limited",
      attrs: { share: "console", status: "used", reads: 1, cached: 1, refused: 1, limited: 1, origins: "https://admin.example.com" },
    });
    expect(drainUse(now)).toEqual([]);
  });
});
