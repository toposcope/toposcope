import { describe, expect, test } from "bun:test";
import type { ChangeMark } from "../shared/change-mark";
import { hourWindows, maxSideMs, minSideMs, pickHomeMark, windowsAround } from "./home-since";

const now = Date.parse("2026-10-26T13:26:00Z");
const mark = (id: string, kind: ChangeMark["kind"], minutesAgo: number): ChangeMark => ({
  id,
  ts: new Date(now - minutesAgo * 60_000).toISOString(),
  end_ts: null,
  kind,
  service: "billing",
  title: id,
  attrs: {},
});

describe("Home picks the mark (#259, locked 2026-10-26)", () => {
  test("the newest deploy or flag in 24 h, never an incident", () => {
    const marks = [mark("inc", "incident", 24), mark("v0.9", "deploy", 38), mark("flag", "flag", 120), mark("api", "deploy", 257)];
    expect(pickHomeMark(marks, now)?.id).toBe("v0.9");
  });
  test("a note or an incident only when it is all there is", () => {
    expect(pickHomeMark([mark("inc", "incident", 24), mark("note", "note", 60)], now)?.id).toBe("inc");
    expect(pickHomeMark([mark("old", "deploy", 25 * 60)], now)).toBeNull();
  });
});

describe("equal windows around a mark", () => {
  test("the gap to the next mark, capped at 60 min, floored at 5 min", () => {
    const v09 = mark("v0.9", "deploy", 38);
    expect(windowsAround(v09, [v09], now).sideMs).toBe(38 * 60_000);
    const withNext = windowsAround(mark("old", "deploy", 120), [mark("inc", "incident", 100), mark("old", "deploy", 120)], now);
    expect(withNext.sideMs).toBe(20 * 60_000);
    expect(windowsAround(mark("far", "deploy", 600), [mark("far", "deploy", 600)], now).sideMs).toBe(maxSideMs);
    expect(windowsAround(mark("just", "deploy", 1), [mark("just", "deploy", 1)], now).sideMs).toBe(minSideMs);
  });
  test("before ends at the mark; after starts there", () => {
    const v09 = mark("v0.9", "deploy", 30);
    const w = windowsAround(v09, [v09], now);
    expect(w.before.to).toBe(v09.ts);
    expect(w.after.from).toBe(v09.ts);
    expect(Date.parse(w.before.to) - Date.parse(w.before.from)).toBe(Date.parse(w.after.to) - Date.parse(w.after.from));
  });
  test("the quiet reading is the last hour against the hour before", () => {
    const w = hourWindows(now);
    expect(w.after.to).toBe(new Date(now).toISOString());
    expect(w.before.to).toBe(w.after.from);
    expect(w.sideMs).toBe(60 * 60_000);
  });
});
