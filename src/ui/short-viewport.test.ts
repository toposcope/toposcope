import { describe, expect, test } from "bun:test";
import { isShortViewport, shortViewportPx } from "./short-viewport";
import { MARK_LANE_H, markLaneH } from "./components/histogram-marks";

describe("hunt on a laptop-height window (sheet 47b)", () => {
  test("under 820px tall is short", () => {
    expect(shortViewportPx).toBe(820);
    expect(isShortViewport(623)).toBe(true);
    expect(isShortViewport(820)).toBe(false);
  });
  test("the marks lane takes no room when it would draw nothing", () => {
    const quiet = { marks: [], before: null, after: null, monitors: null };
    expect(markLaneH(quiet)).toBe(0);
    expect(markLaneH(null)).toBe(0);
    expect(markLaneH({ ...quiet, before: { id: "m" } as never })).toBe(MARK_LANE_H);
    expect(markLaneH({ ...quiet, marks: [{ id: "m" }] as never })).toBe(MARK_LANE_H);
    expect(markLaneH({ ...quiet, monitors: { items: [{}] } as never })).toBeGreaterThan(MARK_LANE_H);
  });
});
