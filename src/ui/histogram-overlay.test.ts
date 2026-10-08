import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const chart = readFileSync("src/ui/components/histogram-chart.tsx", "utf8");

/** The opening tag of every <svg> the plot stretches to its own box. */
function stretchedSvgs(source: string): string[] {
  return [...source.matchAll(/<svg\b[^>]*preserveAspectRatio="none"[^>]*>/g)].map((m) => m[0]);
}

function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  if (start === -1 || end === -1) {
    throw new Error(`histogram-chart.tsx no longer has ${start === -1 ? from : to}`);
  }
  return source.slice(start, end);
}

describe("a series drawn over the plot", () => {
  // An <svg> with a viewBox and no height is as tall as its width and the
  // viewBox ratio make it, whatever box `inset` gives it. At 1068px wide the
  // overlay was 111px in a 79px plot: the bottom third of its scale hung under
  // the floor and was cut, so a p99 of 0.48 against a peak of 4.83 drew nothing.
  test("every svg the plot stretches takes its height from the plot, not from its viewBox", () => {
    const svgs = stretchedSvgs(chart);
    // Log volume as a line or an area, and the overlaid series.
    expect(svgs).toHaveLength(2);
    for (const svg of svgs) {
      expect(svg).toMatch(/\bh-full\b/);
      expect(svg).toMatch(/\bw-full\b/);
    }
  });

  // The count axis on the left stops above the mark lane. The overlaid series'
  // axis on the right ran down beside it, so its 0 sat 22px under the bars.
  test("the overlaid series' axis ends at the plot's floor, above the mark lane", () => {
    const axis = between(chart, "{overlayOn && !replaceY ? (", "{overlayTicks.map(");
    expect(axis).toMatch(/MARK_LANE_H/);
  });
});

// A count is read in whole events. A rate, a p99 or a metric is not: its axis
// took the count's whole-number ticks, so a peak of 4.83 read 3 and 2 on the
// gridlines where 3.22 and 1.61 are drawn, and a peak of 0.48 read 0 and 0.
describe("the axis of a series", () => {
  test("on the right in Overlay it takes a series' ticks", () => {
    const ticks = between(chart, "const overlayTicks =", ";");
    expect(ticks).toMatch(/histogramYTicks\(\s*overlayPeak,/);
    expect(ticks).toMatch(/"series"/);
  });

  test("on the left in Replace it takes a series' ticks", () => {
    const ticks = between(chart, "const yTicks =", ";");
    expect(ticks).toMatch(/replaceY && overlayOn/);
    expect(ticks).toMatch(/"series"/);
  });
});
