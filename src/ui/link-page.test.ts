import { describe, expect, test } from "bun:test";
import { behindLagWords, behindWords, furtherWords, kindLineWords, kindsCarried, linkKind, linkTitle, quarterBars, ratePerHour, type KindLine } from "./link-page";

describe("a link's page words (#267)", () => {
  test("title, behind, rate", () => {
    expect(linkTitle({ role: "pull", peer: "ci-box" })).toBe("ci-box");
    expect(linkKind({ role: "pull" })).toEqual({ glyph: "←", words: "we copy from" });
    expect(linkKind({ role: "serve" })).toEqual({ glyph: "→", words: "copies from us" });
    expect(linkTitle({ role: "serve", peer: "ian-laptop" })).toBe("ian-laptop");
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

describe("a line per kind (#329, 33b)", () => {
  const line = (over: Partial<KindLine>): KindLine => ({ kind: "logs", ticked: true, state: "caught up", rows_day: 0, bytes_day: 0, ...over });
  const pull = { role: "pull" as const, peer: "edge-1" };
  test("each state in words, with its dot", () => {
    expect(kindLineWords(line({}), pull)).toEqual({ state: "caught up", tone: "ok", note: "rows, message text included" });
    expect(kindLineWords(line({ kind: "profiles", ticked: false, state: "unticked at the source" }), pull)).toEqual({ state: "unticked at the source", tone: "off", note: "edge-1 sends none on this link" });
    expect(kindLineWords(line({ kind: "traces", state: "unticked at the source", ticked: false }), { role: "serve", peer: "x" }).note).toBe("this instance sends none on this link");
    expect(kindLineWords(line({ kind: "traces", state: "not sent", not_sent: "the filter names level" }), pull)).toEqual({ state: "not sent", tone: "off", note: "not sent: the filter names level" });
    expect(kindLineWords(line({ kind: "metrics", state: "a hole", gone: { from: Date.parse("2026-10-19T03:00:00Z"), to: Date.parse("2026-10-20T09:00:00Z") } }), pull)).toEqual({
      state: "a hole",
      tone: "warn",
      note: "2026-10-19 → 2026-10-20 gone at the source",
    });
    expect(kindLineWords(line({ state: "paused" }), pull).tone).toBe("warn");
    expect(kindLineWords(line({ state: "behind" }), pull).state).toBe("behind");
  });
  test("what it carries and what is unticked", () => {
    expect(kindsCarried([line({}), line({ kind: "marks" }), line({ kind: "profiles", ticked: false })])).toEqual({ carries: ["logs", "marks"], unticked: ["profiles"] });
  });
});

describe("a source two hops away (#334)", () => {
  const now = Date.parse("2026-10-28T15:00:00Z");
  test("the Behind card says how far behind in time once past a poll's worth, not while paused", () => {
    expect(behindLagWords({ behind_ms: 240_000, paused: false })).toBe("4m behind");
    expect(behindLagWords({ behind_ms: 5_000, paused: false })).toBeNull();
    expect(behindLagWords({ behind_ms: 240_000, paused: true })).toBeNull();
    expect(behindLagWords({ behind_ms: null, paused: false })).toBeNull();
  });
  test("each source further away in Search's words", () => {
    expect(furtherWords({ name: "edge-fra", filters: [], state: { kind: "behind", readTo: now - 240_000 }, hole: null }, now)).toEqual({
      text: "4m behind · read to 14:56:00",
      ok: false,
    });
    expect(furtherWords({ name: "edge-fra", filters: [], state: { kind: "caught-up" }, hole: null }, now)).toEqual({ text: "caught up", ok: true });
  });
});
