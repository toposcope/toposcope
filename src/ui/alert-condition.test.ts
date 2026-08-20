import { describe, expect, test } from "bun:test";
import { fireWhenHint, queryPreview, savedWindowLabel } from "./alert-condition";

describe("savedWindowLabel", () => {
  test("relative range is Last Nh", () => {
    expect(
      savedWindowLabel({ range: "1h", from_ts: null, to_ts: null }),
    ).toBe("Last 1h");
  });

  test("falls back when the window is missing", () => {
    expect(
      savedWindowLabel({ range: null, from_ts: null, to_ts: null }),
    ).toBe("this window");
  });
});

describe("fireWhenHint", () => {
  test("names count, rate, and p99", () => {
    expect(fireWhenHint(null)).toBe("matching events in the window");
    expect(fireWhenHint("rate")).toBe("events per second in the window");
    expect(fireWhenHint("p99:duration_ms")).toBe("window p99(duration_ms)");
  });
});

describe("queryPreview", () => {
  test("empty is a star", () => {
    expect(queryPreview("")).toBe("*");
    expect(queryPreview("level:error")).toBe("level:error");
  });
});
