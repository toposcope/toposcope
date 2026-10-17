import { describe, expect, test } from "bun:test";
import {
  followChangedWords,
  followChipWords,
  followOpened,
  followOpenedWords,
  type FollowOpened,
} from "./follow-span";

const at = Date.parse("2026-10-15T06:20:41.118Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("followOpened", () => {
  test("first to last seen, out to whole seconds", () => {
    const first = Date.parse("2026-10-14T09:12:03.412Z");
    const opened = followOpened(at, { n: 12, first: iso(first), last: iso(at) });
    expect(opened.how).toBe("span");
    expect(iso(opened.fromMs)).toBe("2026-10-14T09:12:03.000Z");
    expect(iso(opened.toMs)).toBe("2026-10-15T06:20:42.000Z");
  });

  test("a last row on a whole second is still inside the window", () => {
    const last = Date.parse("2026-10-15T06:20:41.000Z");
    const opened = followOpened(last, { n: 2, first: "2026-10-14T09:12:03.000Z", last: iso(last) });
    expect(opened.toMs).toBeGreaterThan(last);
  });

  test("never shorter than ±5m: a short span is centred and widened to 10m", () => {
    const opened = followOpened(at, { n: 3, first: iso(at - 60_000), last: iso(at) });
    expect(opened.how).toBe("span");
    expect(opened.fromMs).toBeLessThanOrEqual(at - 60_000);
    expect(opened.toMs).toBeGreaterThan(at);
    expect(opened.toMs - opened.fromMs).toBeGreaterThanOrEqual(600_000);
    expect(opened.toMs - opened.fromMs).toBeLessThanOrEqual(602_000);
  });

  test("the event itself stays inside even when the read did not find it", () => {
    const opened = followOpened(at, {
      n: 2,
      first: "2026-10-14T09:12:03.000Z",
      last: "2026-10-14T22:12:06.000Z",
    });
    expect(opened.toMs).toBeGreaterThan(at);
  });

  test("seen once, none, refused and failed open ±5m around the event", () => {
    const around = { fromMs: Date.parse("2026-10-15T06:15:41.000Z"), toMs: Date.parse("2026-10-15T06:25:42.000Z") };
    expect(followOpened(at, { n: 1, first: iso(at), last: iso(at) })).toEqual({ how: "once", ...around });
    expect(followOpened(at, { n: 0, first: null, last: null })).toEqual({ how: "none", ...around });
    expect(
      followOpened(at, { n: null, first: null, last: null, refused: "this query exceeds the scan budget" }),
    ).toEqual({ how: "refused", ...around });
    expect(followOpened(at, null)).toEqual({ how: "failed", ...around });
  });
});

describe("cut at a day", () => {
  test("first to last seen, still seen past an end", () => {
    const span = { n: 40, first: "2026-10-14T06:21:00.000Z", last: iso(at) };
    expect(followOpened(at, span).cut).toBeUndefined();
    expect(followOpened(at, { ...span, pastBefore: true }).cut).toBe("before");
    expect(followOpened(at, { ...span, pastAfter: true }).cut).toBe("after");
    expect(followOpened(at, { ...span, pastBefore: true, pastAfter: true }).cut).toBe("both");
    // Seen once in the day: ±5m, and nothing to cut.
    expect(followOpened(at, { n: 1, first: iso(at), last: iso(at), pastBefore: true }).cut).toBeUndefined();
  });

  test("the chip says where", () => {
    const opened = followOpened(at, {
      n: 40,
      first: "2026-10-14T06:21:00.000Z",
      last: iso(at),
      pastBefore: true,
    });
    expect(followChipWords(opened)).toBe("opened on first to last seen · cut at a day before");
    expect(followChangedWords(opened)).toBe("opened on first to last seen · cut at a day before · 24h");
    expect(followChipWords({ ...opened, how: "once" })).toBe("opened ±5m · seen once within a day");
  });
});

describe("follow chip words", () => {
  test("what the tab opened on", () => {
    expect(followOpenedWords("span")).toBe("opened on first to last seen");
    expect(followOpenedWords("once")).toBe("opened ±5m · seen once within a day");
    expect(followOpenedWords("refused")).toBe(
      "opened ±5m · finding its first and last row was too large a read",
    );
  });

  test("once the clock moves, first to last seen says how long it was", () => {
    const opened: FollowOpened = {
      how: "span",
      fromMs: Date.parse("2026-10-14T09:12:03.000Z"),
      toMs: Date.parse("2026-10-15T06:20:42.000Z"),
    };
    expect(followChangedWords(opened)).toBe("opened on first to last seen · 21h 9m");
    expect(followChangedWords({ ...opened, how: "once" })).toBe("opened ±5m · seen once within a day");
  });
});
