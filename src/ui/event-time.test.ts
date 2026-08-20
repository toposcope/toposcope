import { describe, expect, test } from "bun:test";
import {
  eventTableTimeTrack,
  formatEventClock,
  surroundingsTimeTrack,
} from "./event-time";

const iso = "2026-08-14T04:30:00.412Z";
const todayNoon = Date.parse("2026-08-14T12:00:00.000Z");
const hour = 3_600_000;
const twoDays = 48 * hour;

describe("formatEventClock", () => {
  test("compact today 1h is clock-only", () => {
    expect(
      formatEventClock(iso, {
        format: "compact",
        fromMs: Date.parse("2026-08-14T11:00:00.000Z"),
        spanMs: hour,
        nowMs: todayNoon,
      }),
    ).toBe("04:30:00");
  });

  test("compact window of 1s or less keeps milliseconds", () => {
    expect(
      formatEventClock(iso, {
        format: "compact",
        fromMs: Date.parse("2026-08-14T04:30:00.000Z"),
        spanMs: 500,
        nowMs: todayNoon,
      }),
    ).toBe("04:30:00.412");
  });

  test("compact 48h prefixes MM-DD", () => {
    expect(
      formatEventClock(iso, {
        format: "compact",
        fromMs: Date.parse("2026-08-12T12:00:00.000Z"),
        spanMs: twoDays,
        nowMs: todayNoon,
      }),
    ).toBe("08-14 04:30:00");
  });

  test("compact not-today 1h prefixes MM-DD", () => {
    expect(
      formatEventClock(iso, {
        format: "compact",
        fromMs: Date.parse("2026-08-13T11:00:00.000Z"),
        spanMs: hour,
        nowMs: todayNoon,
      }),
    ).toBe("08-14 04:30:00");
  });

  test("compact window that crosses midnight prefixes MM-DD", () => {
    expect(
      formatEventClock(iso, {
        format: "compact",
        fromMs: Date.parse("2026-08-13T23:00:00.000Z"),
        spanMs: 2 * hour,
        nowMs: todayNoon,
      }),
    ).toBe("08-14 04:30:00");
  });

  test("compact detail head keeps milliseconds", () => {
    expect(
      formatEventClock(iso, {
        format: "compact",
        fromMs: Date.parse("2026-08-14T11:00:00.000Z"),
        spanMs: hour,
        nowMs: todayNoon,
        precision: "ms",
      }),
    ).toBe("04:30:00.412");
    expect(
      formatEventClock(iso, {
        format: "compact",
        fromMs: Date.parse("2026-08-12T12:00:00.000Z"),
        spanMs: twoDays,
        nowMs: todayNoon,
        precision: "ms",
      }),
    ).toBe("08-14 04:30:00.412");
  });

  test("full is always date and milliseconds", () => {
    expect(
      formatEventClock(iso, {
        format: "full",
        fromMs: Date.parse("2026-08-14T11:00:00.000Z"),
        spanMs: hour,
        nowMs: todayNoon,
      }),
    ).toBe("2026-08-14 04:30:00.412");
  });

  test("invalid iso falls back to the clock slice", () => {
    expect(
      formatEventClock("not-a-time", {
        format: "compact",
        fromMs: todayNoon,
        spanMs: hour,
        nowMs: todayNoon,
      }),
    ).toBe("not-a-time");
  });
});

describe("time column tracks", () => {
  test("widens for dated compact and full", () => {
    expect(eventTableTimeTrack("compact", false)).toBe("minmax(84px,148px)");
    expect(eventTableTimeTrack("compact", true)).toBe("minmax(118px,168px)");
    expect(eventTableTimeTrack("full", false)).toBe("minmax(168px,220px)");
    expect(surroundingsTimeTrack("compact", false)).toBe("78px");
    expect(surroundingsTimeTrack("compact", true)).toBe("118px");
    expect(surroundingsTimeTrack("full", false)).toBe("168px");
  });
});
