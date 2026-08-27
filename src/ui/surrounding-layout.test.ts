import { describe, expect, test } from "bun:test";
import type { LogEvent } from "./types";
import {
  surroundingAnchorIndex,
  surroundingAnchorScrollTop,
  surroundingEventRows,
  surroundingFetchQ,
  surroundingHasMore,
  surroundingMarkLogRows,
} from "./surrounding-layout";
import { surroundingDefaultN, surroundingMaxN } from "../query/surrounding";

function ev(ts: string, message: string): LogEvent {
  return { ts, service: "billing", level: "info", message };
}

const older = [
  ev("2026-08-25T16:29:34.000Z", "older-2"),
  ev("2026-08-25T16:29:36.000Z", "older-1"),
];
const newer = [
  ev("2026-08-25T16:29:38.000Z", "newer-1"),
  ev("2026-08-25T16:29:39.000Z", "newer-2"),
];
const center = ev("2026-08-25T16:29:37.732Z", "pivot");

describe("surroundingEventRows", () => {
  test("puts the event in the middle: older above, newer below", () => {
    const rows = surroundingEventRows(older, center, newer);
    expect(rows.map((row) => row.message)).toEqual([
      "older-2",
      "older-1",
      "pivot",
      "newer-1",
      "newer-2",
    ]);
    expect(surroundingAnchorIndex(older.length)).toBe(2);
    expect(rows[surroundingAnchorIndex(older.length)]).toBe(center);
  });
});

describe("surroundingMarkLogRows", () => {
  test("does not invent a log row for the mark plate", () => {
    const rows = surroundingMarkLogRows(older, newer);
    expect(rows.map((row) => row.message)).toEqual([
      "older-2",
      "older-1",
      "newer-1",
      "newer-2",
    ]);
    expect(rows.some((row) => row.ts === center.ts)).toBe(false);
    expect(surroundingAnchorIndex(older.length)).toBe(older.length);
  });
});

describe("surroundingHasMore", () => {
  test("Earlier/Later when this side filled n and we are under the cap", () => {
    const full = Array.from({ length: surroundingDefaultN }, (_, i) => i);
    const short = full.slice(1);
    expect(surroundingHasMore(full, surroundingDefaultN)).toBe(true);
    expect(surroundingHasMore(short, surroundingDefaultN)).toBe(false);
    expect(surroundingHasMore(full, surroundingMaxN)).toBe(false);
  });
});

describe("surroundingFetchQ", () => {
  test("mark focus never sends the hunt query", () => {
    expect(surroundingFetchQ(true, "all", "level:error")).toBeUndefined();
    expect(surroundingFetchQ(true, "match", "level:error")).toBeUndefined();
  });

  test("event Matching sends q; All does not", () => {
    expect(surroundingFetchQ(false, "match", "level:error")).toBe("level:error");
    expect(surroundingFetchQ(false, "all", "level:error")).toBeUndefined();
    expect(surroundingFetchQ(false, "match", "  ")).toBeUndefined();
  });
});

describe("surroundingAnchorScrollTop", () => {
  test("centers the mark plate after 50 older rows in a short scroller", () => {
    const rowH = 30;
    const older = 50;
    const scroller = { top: 80, height: 200, scrollTop: 0 };
    const row = { top: scroller.top + older * 26, height: rowH };
    const next = surroundingAnchorScrollTop(scroller, row);
    const rowTopAfter = row.top - (next - scroller.scrollTop);
    expect(rowTopAfter + rowH / 2).toBe(scroller.top + scroller.height / 2);
    expect(next).toBeGreaterThan(0);
  });

  test("leaves scrollTop alone when the anchor is already centered", () => {
    const scroller = { top: 40, height: 240, scrollTop: 880 };
    const row = { top: 40 + 120 - 13, height: 26 };
    expect(surroundingAnchorScrollTop(scroller, row)).toBe(880);
  });
});
