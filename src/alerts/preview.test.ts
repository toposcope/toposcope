import { describe, expect, test } from "bun:test";
import { nextThreshold, stretchesOf, type PreviewPoint } from "./preview";

const step = 15 * 60_000;
const t0 = Date.parse("2026-10-25T13:30:00Z");
const series = (values: number[]): PreviewPoint[] => values.map((v, i) => ({ t: new Date(t0 + i * step).toISOString(), v }));

describe("Watch this: would have opened (#264)", () => {
  test("consecutive failing points are one stretch; one still failing at the end is open", () => {
    const s = series([1, 3, 3, 1, 1, 4, 5]);
    expect(stretchesOf(s, "at_least", 2, step)).toEqual([
      { from: s[1]!.t, to: s[3]!.t },
      { from: s[5]!.t, to: null },
    ]);
  });
  test("fewer than opens on quiet points", () => {
    const s = series([12, 3, 15, 2]);
    expect(stretchesOf(s, "fewer_than", 10, step).length).toBe(2);
  });
  test("a higher threshold that would have opened fewer times", () => {
    const s = series([1, 3, 1, 9, 9, 1]);
    expect(nextThreshold(s, "at_least", 2, step)).toEqual({ threshold: 4, opens: 1 });
    expect(nextThreshold(series([1, 1]), "at_least", 2, step)).toBeNull();
  });
});

import { fillSteps } from "./preview";
describe("the preview's bars", () => {
  test("a count's missing bars are zeros on the step grid; a stat's stay out", () => {
    const filled = fillSteps([{ t: new Date(t0 + step).toISOString(), v: 4 }], t0, t0 + 4 * step, step, true);
    expect(filled.map((p) => p.v)).toEqual([0, 4, 0, 0]);
    expect(fillSteps([], t0, t0 + 4 * step, step, false)).toEqual([]);
  });
});

import { shareSteps } from "./preview";
describe("a share's bars (#279)", () => {
  test("each bar's matching rows over every row in it, in percent; a bar with no rows is left out", () => {
    const t = (i: number) => new Date(t0 + i * step).toISOString();
    expect(shareSteps([{ t: t(0), v: 2 }, { t: t(1), v: 0 }, { t: t(2), v: 1 }], [{ t: t(0), v: 100 }, { t: t(1), v: 0 }, { t: t(2), v: 4 }])).toEqual([
      { t: t(0), v: 2 },
      { t: t(2), v: 25 },
    ]);
  });
});
