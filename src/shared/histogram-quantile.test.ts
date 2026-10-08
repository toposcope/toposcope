import { describe, expect, test } from "bun:test";
import { bucketQuantile, bucketSums } from "./histogram-quantile";

const inf = Number.POSITIVE_INFINITY;

describe("bucketSums", () => {
  test("reads bounds and counts in any order, with null as the bound above them all", () => {
    expect(bucketSums([null, 0.01, 0.005], [11, 8, 1])).toEqual({
      le: [0.005, 0.01, inf],
      n: [1, 8, 11],
    });
  });

  test("an empty answer is no buckets", () => {
    expect(bucketSums(undefined, undefined)).toEqual({ le: [], n: [] });
    expect(bucketSums([], [])).toEqual({ le: [], n: [] });
  });
});

describe("bucketQuantile", () => {
  test("no observations is no answer", () => {
    expect(bucketQuantile(0.99, { le: [], n: [] })).toBeNull();
    expect(bucketQuantile(0.99, { le: [1, inf], n: [0, 0] })).toBeNull();
  });

  test("draws a straight line across the bucket the rank lands in", () => {
    // 100 observations: 50 up to 100, 40 in (100, 200], 10 in (200, 400].
    const sums = { le: [100, 200, 400, inf], n: [50, 40, 10, 0] };
    expect(bucketQuantile(0.5, sums)).toBe(100);
    expect(bucketQuantile(0.9, sums)).toBe(200);
    expect(bucketQuantile(0.99, sums)).toBeCloseTo(380, 6);
    expect(bucketQuantile(0.25, sums)).toBe(50);
  });

  test("the first bucket starts at zero when its bound is above zero", () => {
    expect(bucketQuantile(0.5, { le: [10, inf], n: [4, 0] })).toBe(5);
  });

  test("a first bucket at or below zero has no known start, so its bound is the answer", () => {
    expect(bucketQuantile(0.5, { le: [-5, 0, inf], n: [4, 0, 0] })).toBe(-5);
  });

  test("past the highest bound the answer is that bound", () => {
    expect(bucketQuantile(0.99, { le: [1, 5, inf], n: [1, 1, 98] })).toBe(5);
  });

  test("a bound with no count still ends the bucket before it", () => {
    // An exponential histogram's lowest bucket: (1, 1.09], with 1 sent as an empty edge.
    const sums = { le: [1, 1.09, inf], n: [0, 10, 0] };
    expect(bucketQuantile(0.5, sums)).toBeCloseTo(1.045, 6);
  });

  test("the answer never leaves the bucket it lands in", () => {
    const sums = { le: [5, 10, 25, 50, 100, inf], n: [3, 0, 12, 0, 5, 0] };
    for (const q of [0.01, 0.2, 0.5, 0.75, 0.9, 0.99, 1]) {
      const value = bucketQuantile(q, sums)!;
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
    expect(bucketQuantile(0.5, sums)).toBeGreaterThan(10);
    expect(bucketQuantile(0.5, sums)).toBeLessThanOrEqual(25);
  });
});
