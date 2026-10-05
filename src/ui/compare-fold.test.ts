import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compareFoldFetchKey } from "./compare-fold";
import * as compareFold from "./compare-fold";
import { parseChangeMark } from "../shared/change-mark";
import { parseMetricLabels } from "../shared/metric";
import { toLocalInput } from "./search-url";

const exactFrom = Date.parse("2026-10-05T08:00:05.125Z");
const exactTo = Date.parse("2026-10-05T09:00:05.125Z");
const mark = parseChangeMark({
  id: "mk_compare_clock",
  ts: "2026-10-05T08:30:05.125Z",
  kind: "deploy",
  service: "billing",
  title: "v0.9",
});

describe("compareFoldWindows", () => {
  test("custom windows use exact UTC from/to rather than floored plot bounds", () => {
    const input = {
      mark,
      openedAt: "2026-10-05T09:01:00.000Z",
      from: toLocalInput(new Date(exactFrom)),
      to: toLocalInput(new Date(exactTo)),
      live: false,
      huntFromMs: Date.parse("2026-10-05T08:00:00.000Z"),
      huntToMs: Date.parse("2026-10-05T09:00:00.000Z"),
    };
    expect(compareFold.compareFoldWindows(input)).toEqual({
      afterFrom: Date.parse(mark.ts),
      afterTo: exactTo,
      beforeFrom: exactFrom,
      beforeTo: Date.parse(mark.ts),
      sideMs: 30 * 60_000,
      banded: false,
      dead: false,
      pastPlotFrom: false,
      openIncident: false,
    });
    expect(
      compareFold.compareFoldWindows({
        ...input,
        from: toLocalInput(new Date(exactFrom + 1000)),
      }).pastPlotFrom,
    ).toBe(true);
  });

  test("Live fixes afterTo at openedAt even when the final plot bucket ends earlier", () => {
    const input = {
      mark,
      openedAt: "2026-10-05T09:00:05.125Z",
      from: toLocalInput(new Date(exactFrom)),
      to: toLocalInput(new Date(exactTo)),
      live: true,
      huntFromMs: Date.parse("2026-10-05T08:00:00.000Z"),
      huntToMs: Date.parse("2026-10-05T09:00:00.000Z"),
    };
    const expected = {
      afterFrom: Date.parse(mark.ts),
      afterTo: Date.parse(input.openedAt),
      beforeFrom: exactFrom,
      beforeTo: Date.parse(mark.ts),
      sideMs: 30 * 60_000,
    };
    expect(compareFold.compareFoldWindows(input)).toMatchObject(expected);
    expect(
      compareFold.compareFoldWindows({
        ...input,
        from: toLocalInput(new Date(exactFrom + 60_000)),
        to: toLocalInput(new Date(exactTo + 60_000)),
        huntFromMs: input.huntFromMs + 60_000,
        huntToMs: input.huntToMs + 60_000,
      }),
    ).toMatchObject(expected);
  });
});

describe("compareFoldExtraRows", () => {
  test("one fold line needs no extra grid rows", () => {
    expect(compareFold.compareFoldExtraRows(1)).toBe(0);
  });

  test("head and three split rows need two extra 64px grid rows with 8px gaps", () => {
    expect(compareFold.compareFoldExtraRows(4)).toBe(2);
  });

  test("head, eight split rows, and other need four extra grid rows", () => {
    expect(compareFold.compareFoldExtraRows(10)).toBe(4);
  });
});

describe("compareFoldMetricLabels", () => {
  test("a host named events still narrows the metric matcher", () => {
    expect(parseMetricLabels(compareFold.compareFoldMetricLabels("service:billing", "host", "events"))).toEqual({service: "billing", host: "events"});
  });

  test("adding a split matcher preserves all existing metric matchers", () => {
    const labels = compareFold.compareFoldMetricLabels(
      "service:billing,region:eu,version:v0.9",
      "host",
      "billing-2",
    );
    expect(parseMetricLabels(labels)).toEqual({
      service: "billing",
      region: "eu",
      version: "v0.9",
      host: "billing-2",
    });
  });

  for (const split of ["host", "service", "level"] as const) {
    test(`${split} split returns an empty row for a conflicting pinned matcher`, () => {
      expect(
        compareFold.compareFoldMetricLabels(
          `${split}:pinned,region:eu`,
          split,
          "different",
        ),
      ).toBeNull();
    });
  }

  test("adding a fifth metric matcher throws an error naming the four-matcher cap", () => {
    expect(() =>
      compareFold.compareFoldMetricLabels(
        "service:billing,region:eu,version:v0.9,flag:enabled",
        "host",
        "billing-2",
      ),
    ).toThrow(/(?:4.*match|match.*4)/i);
  });

  test("a matching split field preserves the original labels at the matcher cap", () => {
    const ml = "service:billing,host:billing-2,region:eu,version:v0.9";
    expect(
      parseMetricLabels(
        compareFold.compareFoldMetricLabels(ml, "host", "billing-2"),
      ),
    ).toEqual(parseMetricLabels(ml));
  });

  test("an unsplit row preserves the original metric matchers", () => {
    const ml = "service:billing,host:billing-2,region:eu,version:v0.9";
    expect(
      parseMetricLabels(compareFold.compareFoldMetricLabels(ml, "none", "all")),
    ).toEqual(parseMetricLabels(ml));
  });
});

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
      split: "none",
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
    expect(compareFoldFetchKey(live)).not.toBe(
      compareFoldFetchKey({ ...live, split: "host" }),
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
    expect(fold).toMatch(/>\s*split\s*</);
    expect(fold).not.toMatch(/<select/);
    expect(chart).toMatch(/CompareFold/);
    expect(chart).toMatch(/seriesKeys=\{keys\}/);
  });

  test("fold follows the hunt histogram split; × dismisses only the stack", () => {
    const fold = readFileSync("src/ui/components/compare-fold.tsx", "utf8");
    expect(fold).toMatch(/split !== "none"/);
    expect(fold).toMatch(/seriesColor/);
    expect(fold).not.toMatch(/onSplit/);
    const app = readFileSync("src/ui/App.tsx", "utf8");
    const open = app.slice(
      app.indexOf("function openCompare"),
      app.indexOf("function restorePaint"),
    );
    expect(open).not.toMatch(/setSplit\(/);
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
