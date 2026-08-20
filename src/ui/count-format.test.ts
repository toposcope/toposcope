import { describe, expect, test } from "bun:test";
import { formatCompactCount, formatFieldCount } from "./count-format";

describe("formatCompactCount", () => {
  test("keeps values under 1000 exact", () => {
    expect(formatCompactCount(0)).toBe("0");
    expect(formatCompactCount(999)).toBe("999");
  });

  test("uses K and M like 1.24K and 3.04M", () => {
    expect(formatCompactCount(1240)).toBe("1.24K");
    expect(formatCompactCount(3_040_000)).toBe("3.04M");
    expect(formatCompactCount(15_637_603)).toBe("15.6M");
    expect(formatCompactCount(67_144_521)).toBe("67.1M");
    expect(formatCompactCount(7313739)).toBe("7.31M");
  });

  test("drops trailing zeros", () => {
    expect(formatCompactCount(1000)).toBe("1K");
    expect(formatCompactCount(1_800_000)).toBe("1.8M");
    expect(formatCompactCount(156_000)).toBe("156K");
  });
});

describe("formatFieldCount", () => {
  test("raw uses grouped digits", () => {
    expect(formatFieldCount(67144521, "raw")).toBe("67,144,521");
    expect(formatFieldCount(1240, "human")).toBe("1.24K");
  });
});
