import { describe, expect, test } from "bun:test";
import { compileQuery } from "./compile";
import {
  aggLabel,
  seriesLabel,
  alignAggBuckets,
  canUseNumericAgg,
  finiteAggPeak,
  formatSearchAgg,
  isNumericAggBudgetError,
  mergeAggBuckets,
  numericBudgetRefuseReason,
  numericFieldRefuseReason,
  numericKeyRefuseReason,
  numericScanSettings,
  numericScanSql,
  parseSearchAgg,
  rateFromHistogram,
  windowSeconds,
} from "./agg";

describe("parseSearchAgg", () => {
  test("empty is off", () => {
    expect(parseSearchAgg(undefined)).toBeNull();
    expect(parseSearchAgg("")).toBeNull();
    expect(parseSearchAgg("  ")).toBeNull();
  });

  test("rate and numeric ops", () => {
    expect(parseSearchAgg("rate")).toEqual({ op: "rate" });
    expect(parseSearchAgg("p99:duration_ms")).toEqual({
      op: "p99",
      key: "duration_ms",
    });
    expect(parseSearchAgg("AVG:Duration_ms")).toEqual({
      op: "avg",
      key: "duration_ms",
    });
    expect(formatSearchAgg({ op: "p99", key: "duration_ms" })).toBe(
      "p99:duration_ms",
    );
    expect(aggLabel({ op: "p99", key: "duration_ms" })).toBe(
      "p99(duration_ms)",
    );
    expect(seriesLabel(null)).toBe("Count");
    expect(seriesLabel("rate")).toBe("rate");
    expect(seriesLabel("p99:duration_ms")).toBe("p99(duration_ms)");
  });

  test("rejects junk, core fields, and infix keys", () => {
    expect(() => parseSearchAgg("nope")).toThrow(/Invalid agg/);
    expect(() => parseSearchAgg("p99")).toThrow(/Invalid agg/);
    expect(() => parseSearchAgg("p99:level")).toThrow(/Invalid agg/);
    expect(() => parseSearchAgg("p99:foo-bar")).toThrow(/Invalid agg/);
    expect(() => parseSearchAgg("p50:duration_ms")).toThrow(/Invalid agg/);
  });
});

describe("canUseNumericAgg", () => {
  test("core-field queries can use the numeric MV", () => {
    expect(canUseNumericAgg(compileQuery(""))).toBe(true);
    expect(canUseNumericAgg(compileQuery("level:error service:api"))).toBe(
      true,
    );
    expect(canUseNumericAgg(compileQuery("level:error OR level:fatal"))).toBe(
      true,
    );
  });

  test("message terms, extra attrs, and mixed OR scan logs instead of the MV", () => {
    expect(canUseNumericAgg(compileQuery("timeout"))).toBe(false);
    expect(canUseNumericAgg(compileQuery("status:5*"))).toBe(false);
    expect(canUseNumericAgg(compileQuery("user_id:u-5"))).toBe(false);
    expect(
      canUseNumericAgg(compileQuery("level:error OR status:500")),
    ).toBe(false);
    expect(canUseNumericAgg(compileQuery("duration_ms:>100"))).toBe(false);
    expect(numericKeyRefuseReason("duration_ms")).toBeNull();
    expect(numericKeyRefuseReason("request_id", ["request_id"])).toBe(
      numericFieldRefuseReason,
    );
    expect(numericKeyRefuseReason("level")).toBe(numericFieldRefuseReason);
  });
});

describe("numeric scan SQL", () => {
  test("p99 is a t-digest over finite attr_map values", () => {
    expect(numericScanSql("p99")).toContain("quantileTDigest(0.99)");
    expect(numericScanSql("p99")).toContain("toFloat64OrNull");
    expect(numericScanSettings).toContain("read_overflow_mode = 'throw'");
    expect(numericScanSettings).not.toContain("'break'");
  });

  test("overflow and abort map to the budget refuse", () => {
    expect(
      isNumericAggBudgetError(
        new Error(
          "ClickHouse query failed: Code: 158. DB::Exception: Limit for rows (controlled by 'max_rows_to_read' setting) exceeded. (TOO_MANY_ROWS)",
        ),
      ),
    ).toBe(true);
    const abort = new Error("The operation was aborted.");
    abort.name = "AbortError";
    expect(isNumericAggBudgetError(abort)).toBe(true);
    expect(isNumericAggBudgetError(new Error("Connection refused"))).toBe(
      false,
    );
    expect(numericBudgetRefuseReason).toMatch(/scan budget/);
  });
});

describe("rateFromHistogram", () => {
  test("is count per bucket width and window", () => {
    const result = rateFromHistogram(
      [
        { t: "2026-08-14T14:00:00.000Z", n: 60 },
        { t: "2026-08-14T14:01:00.000Z", n: 120 },
      ],
      60,
      120,
    );
    expect(result.source).toBe("rate");
    expect(result.buckets.map((b) => b.v)).toEqual([1, 2]);
    expect(result.stat).toBe(1.5);
  });
});

describe("windowSeconds / merge / align", () => {
  test("windowSeconds", () => {
    expect(
      windowSeconds(
        "2026-08-14T14:00:00.000Z",
        "2026-08-14T15:00:00.000Z",
      ),
    ).toBe(3600);
    expect(windowSeconds(null, null)).toBe(0);
  });

  test("merge replaces overlapping buckets", () => {
    expect(
      mergeAggBuckets(
        [
          { t: "a", v: 1 },
          { t: "b", v: 2 },
        ],
        [{ t: "b", v: 9 }],
      ),
    ).toEqual([
      { t: "a", v: 1 },
      { t: "b", v: 9 },
    ]);
  });

  test("align leaves missing times as null", () => {
    expect(
      alignAggBuckets(
        ["a", "b", "c"],
        [
          { t: "a", v: 1.5 },
          { t: "c", v: 3 },
        ],
      ),
    ).toEqual([1.5, null, 3]);
    expect(finiteAggPeak([1.5, null, 3])).toBe(3);
  });
});
