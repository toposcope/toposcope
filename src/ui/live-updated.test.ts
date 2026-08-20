import { describe, expect, test } from "bun:test";
import { formatLiveUpdatedAge, liveUpdatedLabel } from "./live-updated";

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
