import { describe, expect, test } from "bun:test";
import { heatCells } from "./metric-series";
import { heatRowFraction } from "../ui/components/metric-spark";

describe("a histogram as a heatmap (#238)", () => {
  test("bars whose bounds differ land on one grid: the union of bounds", () => {
    const grid = heatCells([
      { t: "a", sums: { le: [10, 100, Infinity], n: [5, 2, 1] } },
      { t: "b", sums: { le: [10, 50, 100, Infinity], n: [1, 3, 4, 0] } },
    ]);
    expect(grid.le).toEqual([10, 50, 100, Infinity]);
    expect(grid.cells).toEqual([
      { t: "a", n: [5, 0, 2, 1] },
      { t: "b", n: [1, 3, 4, 0] },
    ]);
  });

  test("the p99 line sits in the row of the first bound at or above it", () => {
    const le = [10, 100, 1000, Infinity];
    expect(heatRowFraction(le, 5)).toBeCloseTo(0.125);
    expect(heatRowFraction(le, 100)).toBeCloseTo(0.5);
    expect(heatRowFraction(le, 5000)).toBeGreaterThan(0.75);
  });
});
