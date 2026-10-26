import { describe, expect, test } from "bun:test";
import { behindWords, linkTitle, quarterBars, ratePerHour } from "./link-page";

describe("a link's page words (#267)", () => {
  test("title, behind, rate", () => {
    expect(linkTitle({ role: "pull", peer: "ci-box" })).toBe("ci-box → here");
    expect(linkTitle({ role: "serve", peer: "ian-laptop" })).toBe("here → ian-laptop");
    expect(behindWords({ behind_rows: 4, position: 1, settled: 1, paused: false })).toEqual({ text: "4 rows", ok: true });
    expect(behindWords({ behind_rows: null, position: 5, settled: 5, paused: false })).toEqual({ text: "caught up", ok: true });
    expect(behindWords({ behind_rows: 0, position: 5, settled: 5, paused: true })).toEqual({ text: "paused", ok: false });
    expect(ratePerHour(50_400)).toBe("2.1K/h");
  });
  test("96 quarter-hours with a gap as a floor", () => {
    const now = Date.parse("2026-10-26T13:26:00Z");
    const bars = quarterBars([{ t: "2026-10-26T13:00:00.000Z", n: 12 }], [{ from: "2026-10-26T09:14:00Z", to: "2026-10-26T09:20:00Z" }], now);
    expect(bars.length).toBe(96);
    expect(bars.find((b) => b.t === Date.parse("2026-10-26T13:00:00Z"))!.n).toBe(12);
    // 09:14–09:20 touches the 09:00 and the 09:15 quarter.
    expect(bars.filter((b) => b.gap).length).toBe(2);
  });
});
