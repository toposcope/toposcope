import { describe, expect, test } from "bun:test";
import {
  autoChipInterval,
  clickHistogramWindow,
  dragHistogramWindow,
  histogramChipDrawable,
  histogramExploreResetLabel,
  histogramHoverHint,
  histogramRetentionMs,
  minHistogramZoomMs,
  nextHistogramZoomMs,
  histogramChartNeedsRefetch,
  panHistogramWindow,
  resolveQueryHistogramStep,
  snapHistogramSpanMs,
  standingChipInterval,
  zoomHistogramAbout,
} from "./histogram-zoom";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("snapHistogramSpanMs", () => {
  test("snaps a one-minute bar to 1m, not 5m", () => {
    expect(snapHistogramSpanMs(MINUTE)).toBe(MINUTE);
    expect(snapHistogramSpanMs(2 * MINUTE)).toBe(5 * MINUTE);
    expect(snapHistogramSpanMs(5 * MINUTE)).toBe(5 * MINUTE);
    expect(snapHistogramSpanMs(HOUR)).toBe(HOUR);
    expect(snapHistogramSpanMs(1)).toBe(1);
  });
});

describe("nextHistogramZoomMs", () => {
  test("steps the ladder about the nearest rung", () => {
    expect(nextHistogramZoomMs(HOUR, -1)).toBe(30 * MINUTE);
    expect(nextHistogramZoomMs(HOUR, 1)).toBe(4 * HOUR);
    expect(nextHistogramZoomMs(5 * MINUTE, -1)).toBe(MINUTE);
    expect(nextHistogramZoomMs(1, -1)).toBeNull();
    expect(nextHistogramZoomMs(7 * 24 * HOUR, 1)).toBe(14 * 24 * HOUR);
    expect(nextHistogramZoomMs(365 * 24 * HOUR, 1)).toBeNull();
  });
});

describe("zoomHistogramAbout", () => {
  test("keeps the cursor in the middle of the next span", () => {
    const center = Date.parse("2026-08-14T15:00:00.000Z");
    const next = zoomHistogramAbout(HOUR, center, -1);
    expect(next).toEqual({
      fromMs: center - 15 * MINUTE,
      toMs: center + 15 * MINUTE,
    });
  });
});

describe("clickHistogramWindow", () => {
  test("tightens a 1m bar on a 1h window to 1m", () => {
    const from = Date.parse("2026-08-14T14:30:00.000Z");
    const win = clickHistogramWindow(from, from + MINUTE, HOUR);
    expect(win).toEqual({
      fromMs: from,
      toMs: from + MINUTE,
    });
  });

  test("drills a coarse bar to that bar's ladder span", () => {
    const from = Date.parse("2026-08-14T12:00:00.000Z");
    const win = clickHistogramWindow(from, from + 15 * MINUTE, 24 * HOUR);
    expect(win).toEqual({
      fromMs: from,
      toMs: from + 15 * MINUTE,
    });
  });

  test("can drill a 5m window to 1m", () => {
    const from = Date.parse("2026-08-14T14:30:00.000Z");
    const win = clickHistogramWindow(from, from + MINUTE, 5 * MINUTE);
    expect(win).toEqual({
      fromMs: from,
      toMs: from + MINUTE,
    });
  });

  test("is a no-op at the 1ms floor", () => {
    const from = Date.parse("2026-08-14T14:30:00.000Z");
    expect(clickHistogramWindow(from, from + 1, 1)).toBeNull();
  });
});

describe("panHistogramWindow", () => {
  const to = Date.parse("2026-08-14T15:00:00.000Z");
  const from = to - HOUR;
  const now = to;

  test("slides the window by whole buckets and keeps the span", () => {
    const next = panHistogramWindow(from, to, -MINUTE, now);
    expect(next).toEqual({ fromMs: from - MINUTE, toMs: to - MINUTE });
    expect(next && next.toMs - next.fromMs).toBe(HOUR);
  });

  test("does not pan into the future", () => {
    expect(panHistogramWindow(from, to, MINUTE, now)).toBeNull();
    expect(panHistogramWindow(from, to, 0, now)).toBeNull();
  });

  test("does not pan the left edge before retention", () => {
    const minTo = now - histogramRetentionMs + HOUR;
    expect(panHistogramWindow(minTo - HOUR, minTo, -MINUTE, now)).toBeNull();
  });

  test("pan clamp follows the passed retention", () => {
    const retain = 90 * 24 * HOUR;
    const fortyDaysAgo = now - 40 * 24 * HOUR;
    const next = panHistogramWindow(
      fortyDaysAgo - HOUR,
      fortyDaysAgo,
      -MINUTE,
      now,
      retain,
    );
    expect(next).toEqual({
      fromMs: fortyDaysAgo - HOUR - MINUTE,
      toMs: fortyDaysAgo - MINUTE,
    });
    const minTo = now - retain + HOUR;
    expect(panHistogramWindow(minTo - HOUR, minTo, -MINUTE, now, retain)).toBeNull();
  });

  test("Shift-sized pan moves a whole window", () => {
    const next = panHistogramWindow(from, to, -HOUR, now);
    expect(next).toEqual({ fromMs: from - HOUR, toMs: to - HOUR });
  });
});

describe("histogramHoverHint", () => {
  test("names pan, brush, and head-drill", () => {
    expect(
      histogramHoverHint({
        shiftHeld: false,
        headArmed: false,
        canDrill: true,
        drillLabel: "5m",
      }),
    ).toBe("drag to pan · ⇧drag to select");
    expect(
      histogramHoverHint({
        shiftHeld: true,
        headArmed: false,
        canDrill: true,
        drillLabel: "5m",
      }),
    ).toBe("release to pin this span");
    expect(
      histogramHoverHint({
        shiftHeld: false,
        headArmed: true,
        canDrill: true,
        drillLabel: "5m",
      }),
    ).toBe("click → 5m · drag the head to sweep a span");
  });
});

describe("dragHistogramWindow", () => {
  test("keeps a drawn span and floors a short drag at 1ms", () => {
    const a = Date.parse("2026-08-14T14:00:00.000Z");
    expect(dragHistogramWindow(a, a + 23 * MINUTE)).toEqual({
      fromMs: a,
      toMs: a + 23 * MINUTE,
    });
    const short = dragHistogramWindow(a, a + 2 * MINUTE);
    expect(short.toMs - short.fromMs).toBe(2 * MINUTE);
    expect((short.fromMs + short.toMs) / 2).toBe(a + MINUTE);
    const hair = dragHistogramWindow(a, a + 0.4);
    expect(hair.toMs - hair.fromMs).toBe(minHistogramZoomMs);
  });
});

describe("histogram chips", () => {
  test("Auto · 1m on an hour, 10s on 15m, and grouped Auto goes coarser", () => {
    expect(autoChipInterval(HOUR, "stacked")).toBe("1m");
    expect(autoChipInterval(HOUR, "area")).toBe("1m");
    expect(autoChipInterval(15 * MINUTE, "stacked")).toBe("10s");
    expect(autoChipInterval(1_000, "stacked")).toBe("10ms");
    expect(autoChipInterval(7 * 24 * HOUR, "stacked")).toBe("1h");
    expect(autoChipInterval(365 * 24 * HOUR, "stacked")).toBe("7d");
    expect(autoChipInterval(HOUR, "grouped")).toBe("5m");
    expect(histogramChipDrawable(HOUR, "1m", "stacked")).toBe(true);
    expect(histogramChipDrawable(HOUR, "1m", "grouped")).toBe(false);
    expect(histogramChipDrawable(1, "1ms", "stacked")).toBe(true);
    expect(histogramChipDrawable(1_000, "1s", "stacked")).toBe(true);
  });

  test("stands in for a pinned width that cannot draw", () => {
    expect(standingChipInterval(24 * HOUR, "1m", "stacked")).toBe("15m");
    expect(standingChipInterval(HOUR, "1m", "stacked")).toBe("1m");
  });

  test("query step omits Auto stacked and sends grouped Auto / standing-in", () => {
    expect(resolveQueryHistogramStep(HOUR, null, "stacked")).toBeNull();
    expect(resolveQueryHistogramStep(HOUR, null, "grouped")).toBe("5m");
    expect(resolveQueryHistogramStep(24 * HOUR, "1m", "stacked")).toBe("15m");
    expect(resolveQueryHistogramStep(HOUR, "1m", "stacked")).toBe("1m");
  });

  test("chart switch refetches only when the sent step changes", () => {
    expect(histogramChartNeedsRefetch(HOUR, null, "area", "line")).toBe(false);
    expect(histogramChartNeedsRefetch(HOUR, null, "stacked", "area")).toBe(false);
    expect(histogramChartNeedsRefetch(HOUR, null, "stacked", "grouped")).toBe(
      true,
    );
    expect(histogramChartNeedsRefetch(HOUR, "15m", "line", "grouped")).toBe(
      false,
    );
    expect(histogramChartNeedsRefetch(HOUR, "1m", "line", "grouped")).toBe(true);
  });
});

describe("histogramExploreResetLabel", () => {
  test("names the window the exploration started from", () => {
    expect(histogramExploreResetLabel("1h")).toBe("Last 1h");
    expect(histogramExploreResetLabel("90m")).toBe("Last 90m");
    expect(histogramExploreResetLabel("custom")).toBe("the previous window");
  });
});
