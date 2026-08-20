import { describe, expect, test } from "bun:test";
import {
  eventLookbacksMs,
  eventSliceAtFloor,
  eventSliceFrom,
  skipSearchEvents,
  skipSearchHistogram,
} from "./event-page";

describe("eventSliceFrom", () => {
  test("clamps lookback to the window from", () => {
    expect(
      eventSliceFrom(
        "2026-08-14T00:00:00.000Z",
        "2026-08-14T12:00:00.000Z",
        60_000,
      ),
    ).toBe("2026-08-14T11:59:00.000Z");
    expect(
      eventSliceFrom(
        "2026-08-14T11:50:00.000Z",
        "2026-08-14T12:00:00.000Z",
        60 * 60_000,
      ),
    ).toBe("2026-08-14T11:50:00.000Z");
    expect(eventSliceFrom(undefined, "2026-08-14T12:00:00.000Z", 60_000)).toBe(
      "2026-08-14T11:59:00.000Z",
    );
  });
});

describe("skipSearchHistogram", () => {
  test("cursor pages skip the full-window histogram", () => {
    expect(
      skipSearchHistogram({ cursor: "2026-08-14T15:00:00.000Z" }),
    ).toBe(true);
    expect(
      skipSearchHistogram({
        cursor: "2026-08-14T15:00:00.000Z",
        since: "2026-08-14T15:00:00.000Z",
      }),
    ).toBe(false);
    expect(skipSearchHistogram({})).toBe(false);
  });
});

describe("skipSearchEvents", () => {
  test("events=0 skips the event page", () => {
    expect(skipSearchEvents({ events: "0" })).toBe(true);
    expect(skipSearchEvents({})).toBe(false);
    expect(skipSearchEvents({ events: "1" })).toBe(false);
  });
});

describe("eventSliceAtFloor", () => {
  test("is true when the slice reached from", () => {
    expect(
      eventSliceAtFloor("2026-08-14T11:00:00.000Z", "2026-08-14T11:00:00.000Z"),
    ).toBe(true);
    expect(
      eventSliceAtFloor("2026-08-14T11:00:00.000Z", "2026-08-14T11:59:00.000Z"),
    ).toBe(false);
  });
});

describe("eventLookbacksMs", () => {
  test("starts at one minute and covers the retention max", () => {
    expect(eventLookbacksMs[0]).toBe(60_000);
    expect(eventLookbacksMs[eventLookbacksMs.length - 1]).toBe(
      365 * 24 * 60 * 60 * 1000,
    );
  });
});
