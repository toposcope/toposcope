import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compareFoldFetchKey } from "./compare-fold";

describe("compareFoldFetchKey", () => {
  test("live ignores sliding from/to and refetches when q, span, or series change", () => {
    const live = {
      q: "level:error",
      live: true,
      spanMs: 3_600_000,
      from: "a",
      to: "b",
      agg: "rate" as string | null,
      metric: null as string | null,
      ml: "",
    };
    expect(compareFoldFetchKey(live)).toBe(
      compareFoldFetchKey({ ...live, from: "c", to: "d" }),
    );
    expect(compareFoldFetchKey(live)).not.toBe(
      compareFoldFetchKey({ ...live, spanMs: 7_200_000 }),
    );
    expect(compareFoldFetchKey(live)).not.toBe(
      compareFoldFetchKey({ ...live, q: "e1:aaaaaaaaaaaaaaaa" }),
    );
    expect(compareFoldFetchKey(live)).not.toBe(
      compareFoldFetchKey({ ...live, agg: null }),
    );
    expect(compareFoldFetchKey({ ...live, agg: null })).not.toBe(
      compareFoldFetchKey({ ...live, agg: null, metric: "cpu_seconds" }),
    );
  });
});

describe("compare fold chrome", () => {
  test("inspector Compare sits beside Fingerprints; the fold is 30px under the lane", () => {
    const marks = readFileSync("src/ui/components/histogram-marks.tsx", "utf8");
    const fold = readFileSync("src/ui/components/compare-fold.tsx", "utf8");
    const chart = readFileSync("src/ui/components/histogram-chart.tsx", "utf8");
    expect(marks).toMatch(/Compare/);
    expect(marks).toMatch(/onCompare/);
    expect(fold).toMatch(/h-\[30px\]/);
    expect(fold).toMatch(/ml-\[47px\]/);
    expect(chart).toMatch(/CompareFold/);
  });

  test("fold × does not clear the cut; Compare does not rewrite q", () => {
    const app = readFileSync("src/ui/App.tsx", "utf8");
    expect(app).toMatch(/function openCompare/);
    expect(app).toMatch(/onClose: \(\) => setCompare\(null\)/);
    const open = app.slice(
      app.indexOf("function openCompare"),
      app.indexOf("function restorePaint"),
    );
    expect(open).not.toMatch(/setCut\(null\)/);
    expect(open).not.toMatch(/setQ\(/);
  });
});
