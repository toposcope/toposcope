import { describe, expect, test } from "bun:test";
import { searchReading } from "./watch";

const on = (agg: string | null, measure: "series" | "share" = "series") => ({ measure, saved: { id: "h", name: "h", query: "x", range: "1h", agg } });

describe("what a search monitor last read", () => {
  test("a measure with a unit reads whole, with it", () => {
    expect(searchReading(on("p99:duration_ms"), 1440)).toBe("1440 ms");
    expect(searchReading(on("avg:duration_ms"), 1440.4)).toBe("1440 ms");
    expect(searchReading(on("sum:bytes"), 2048)).toBe("2048 B");
  });

  test("a count, or a measure with no unit, stays compact", () => {
    expect(searchReading(on(null), 1440)).toBe("1.44K");
    expect(searchReading(on("max:items"), 1440)).toBe("1.44K");
  });

  test("a share is not the field's unit", () => {
    expect(searchReading(on("p99:duration_ms", "share"), 7.8)).not.toContain("ms");
  });
});
