import { describe, expect, test } from "bun:test";
import { blankOnFailedRefresh, facetAgeView, formatLiveUpdatedAge, liveUpdatedLabel, oldestFetchedAt } from "./live-updated";

describe("formatLiveUpdatedAge", () => {
  test("seconds, minutes, hours", () => {
    expect(formatLiveUpdatedAge(3_000)).toBe("3s");
    expect(formatLiveUpdatedAge(28_400)).toBe("28s");
    expect(formatLiveUpdatedAge(90_000)).toBe("2m");
    expect(formatLiveUpdatedAge(3_600_000)).toBe("1h");
  });
});

describe("liveUpdatedLabel", () => {
  test("hides a fresh primary poll and names a stale extra", () => {
    expect(liveUpdatedLabel(1_000, 2_500)).toBeNull();
    expect(liveUpdatedLabel(1_000, 4_200)).toBe("3s");
    expect(liveUpdatedLabel(undefined, 4_200)).toBeNull();
  });
});

describe("facetAgeView", () => {
  test("names the age from the first second, so a swap reads as 1s", () => {
    expect(facetAgeView(10_000, 10_200, false)?.label).toBe("1s");
    expect(facetAgeView(10_000, 28_000, false)?.label).toBe("18s");
    expect(facetAgeView(undefined, 28_000, false)).toBeNull();
  });

  test("turns overdue only past one 30s pass plus slack", () => {
    expect(facetAgeView(0, 35_000, false)?.overdue).toBe(false);
    expect(facetAgeView(0, 47_000, false)?.overdue).toBe(true);
  });

  test("a pause while reading is not a missed pass", () => {
    expect(facetAgeView(0, 47_000, true)?.overdue).toBe(false);
  });

  test("the tip names the cadence and the age", () => {
    expect(facetAgeView(0, 18_000, false)?.tip).toBe(
      "Counts refresh every 30s in Live · last 18s ago · minute rollups, the newest minute lands late",
    );
  });
});

describe("oldestFetchedAt", () => {
  test("the oldest known list wins; none known is undefined", () => {
    expect(oldestFetchedAt([5_000, 3_000])).toBe(3_000);
    expect(oldestFetchedAt([undefined, 4_000])).toBe(4_000);
    expect(oldestFetchedAt([undefined, undefined])).toBeUndefined();
  });
});

describe("blankOnFailedRefresh", () => {
  test("a failed Live refresh of the same hunt keeps the chips on screen", () => {
    expect(blankOnFailedRefresh("range=15m&q=level%3Aerror", "range=15m&q=level%3Aerror")).toBe(false);
  });

  test("a new hunt whose facets fail does not keep the old hunt's chips", () => {
    expect(blankOnFailedRefresh("range=15m&q=service%3Aapi", "range=15m&q=level%3Aerror")).toBe(true);
    expect(blankOnFailedRefresh("range=15m", null)).toBe(true);
  });
});
