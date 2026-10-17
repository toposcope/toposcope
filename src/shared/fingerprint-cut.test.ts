import { describe, expect, test } from "bun:test";
import {
  capFingerprintCutSet,
  classifyFingerprintCut,
  fingerprintCutCap,
  fingerprintCutFollows,
  fingerprintCutInsideNotes,
  fingerprintCutMinBeforeMs,
  fingerprintCutNotes,
  nearestInsideMarks,
  fingerprintCutWindows,
  formatFingerprintCutDuration,
  mergeFingerprintCutSides,
} from "./fingerprint-cut";

const hour = 3_600_000;
const openedAt = Date.parse("2026-08-14T15:00:00.000Z");
const huntFrom = openedAt - hour;
const huntTo = openedAt;

describe("fingerprintCutWindows", () => {
  test("point mark: after is mark → freeze, before mirrors even past from", () => {
    const markTs = Date.parse("2026-08-14T14:11:04.221Z");
    const w = fingerprintCutWindows({
      markTs,
      markEndTs: null,
      kind: "deploy",
      huntFrom,
      huntTo,
      openedAt,
    });
    expect(w.banded).toBe(false);
    expect(w.dead).toBe(false);
    expect(w.afterFrom).toBe(markTs);
    expect(w.afterTo).toBe(openedAt);
    expect(w.sideMs).toBe(openedAt - markTs);
    expect(w.beforeTo).toBe(markTs);
    expect(w.beforeFrom).toBe(markTs - w.sideMs);
    expect(w.pastPlotFrom).toBe(true);
  });

  test("does not invent time after hunt to", () => {
    const markTs = huntTo - 10 * 60_000;
    const w = fingerprintCutWindows({
      markTs,
      markEndTs: null,
      kind: "deploy",
      huntFrom,
      huntTo: huntTo - 60_000,
      openedAt,
    });
    expect(w.afterTo).toBe(huntTo - 60_000);
  });

  test("closed incident cuts as the stored band", () => {
    const markTs = Date.parse("2026-08-14T03:10:00.000Z");
    const end = Date.parse("2026-08-14T04:12:00.000Z");
    const w = fingerprintCutWindows({
      markTs,
      markEndTs: end,
      kind: "incident",
      huntFrom: Date.parse("2026-08-14T00:00:00.000Z"),
      huntTo: openedAt,
      openedAt,
    });
    expect(w.banded).toBe(true);
    expect(w.openIncident).toBe(false);
    expect(w.afterFrom).toBe(markTs);
    expect(w.afterTo).toBe(end);
    expect(w.sideMs).toBe(end - markTs);
    expect(w.beforeFrom).toBe(markTs - (end - markTs));
  });

  test("open incident cuts at start, not as a band", () => {
    const markTs = openedAt - 20 * 60_000;
    const w = fingerprintCutWindows({
      markTs,
      markEndTs: openedAt + hour,
      kind: "incident",
      huntFrom,
      huntTo,
      openedAt,
    });
    expect(w.banded).toBe(false);
    expect(w.openIncident).toBe(true);
    expect(w.afterTo).toBe(openedAt);
  });

  test("dead when the window ended before the mark", () => {
    const w = fingerprintCutWindows({
      markTs: huntTo + 60_000,
      markEndTs: null,
      kind: "flag",
      huntFrom,
      huntTo,
      openedAt,
    });
    expect(w.dead).toBe(true);
  });
});

describe("classifyFingerprintCut", () => {
  test("splits first seen, still here, and stopped", () => {
    const { firstSeen, stillHere, stopped } = classifyFingerprintCut([
      { hex: "aa", before: 0, after: 10 },
      { hex: "bb", before: 4, after: 5 },
      { hex: "cc", before: 3, after: 0 },
      { hex: "dd", before: 0, after: 0 },
    ]);
    expect(firstSeen.map((r) => r.hex)).toEqual(["aa"]);
    expect(stillHere.map((r) => r.hex)).toEqual(["bb"]);
    expect(stopped.map((r) => r.hex)).toEqual(["cc"]);
  });
});

describe("capFingerprintCutSet", () => {
  test("keeps ten and counts the leftover", () => {
    const rows = Array.from({ length: 14 }, (_, i) => ({ n: 14 - i }));
    const capped = capFingerprintCutSet(rows, (r) => r.n);
    expect(capped.total).toBe(14);
    expect(capped.rows).toHaveLength(fingerprintCutCap);
    expect(capped.more).toBe(4);
    expect(capped.rows[0]?.n).toBe(14);
  });
});

describe("mergeFingerprintCutSides", () => {
  test("outer-joins hex counts", () => {
    const merged = mergeFingerprintCutSides(
      [
        { hex: "aa", n: 2 },
        { hex: "bb", n: 1 },
      ],
      [
        { hex: "aa", n: 9 },
        { hex: "cc", n: 3 },
      ],
    );
    expect(merged).toEqual([
      { hex: "aa", before: 2, after: 9 },
      { hex: "bb", before: 1, after: 0 },
      { hex: "cc", before: 0, after: 3 },
    ]);
  });
});

describe("fingerprintCutNotes", () => {
  test("names lookback past from and a frozen Live cut", () => {
    const markTs = Date.parse("2026-08-14T14:11:04.221Z");
    const w = fingerprintCutWindows({
      markTs,
      markEndTs: null,
      kind: "deploy",
      huntFrom,
      huntTo,
      openedAt,
    });
    const notes = fingerprintCutNotes(w, {
      live: true,
      now: openedAt + 90_000,
    });
    expect(notes.some((n) => n.includes("left edge"))).toBe(true);
    expect(notes.some((n) => n.includes("Fixed when opened"))).toBe(true);
  });
});

describe("formatFingerprintCutDuration", () => {
  test("formats mixed hours and minutes", () => {
    expect(formatFingerprintCutDuration(11 * hour + 20 * 60_000)).toBe("11h 20m");
    expect(formatFingerprintCutDuration(89_000)).toBe("1m 29s");
  });
});

describe("the before side's minimum (#111)", () => {
  const minute = 60_000;
  const open = Date.parse("2026-10-16T11:00:12.000Z");
  const cut = (markTs: number, extra: Partial<Parameters<typeof fingerprintCutWindows>[0]> = {}) =>
    fingerprintCutWindows({
      markTs,
      markEndTs: null,
      kind: "deploy",
      huntFrom: open - 4 * hour,
      huntTo: open,
      openedAt: open,
      minBeforeMs: fingerprintCutMinBeforeMs,
      ...extra,
    });

  test("18 minutes after a deploy: the hour before, and Stopped waits", () => {
    const markTs = open - 18 * minute;
    const w = cut(markTs);
    expect(w.sideMs).toBe(18 * minute);
    expect(w.beforeMs).toBe(hour);
    expect(w.beforeFrom).toBe(markTs - hour);
    expect(w.beforeTo).toBe(markTs);
    expect(w.waiting).toBe(true);
    expect(fingerprintCutNotes(w, { live: false, now: open })).toEqual([
      "The sides differ until the after side has an hour: counts read 1h before → 18m after.",
    ]);
  });

  test("2 hours after: equal sides, as today", () => {
    const w = cut(open - 2 * hour);
    expect(w.beforeMs).toBe(2 * hour);
    expect(w.waiting).toBe(false);
    expect(fingerprintCutNotes(w, { live: false, now: open })).toEqual([]);
  });

  test("an hour exactly: Stopped is called", () => {
    const w = cut(open - hour);
    expect(w.beforeMs).toBe(hour);
    expect(w.waiting).toBe(false);
  });

  test("under 5 minutes: one note says both", () => {
    const w = cut(open - 3 * minute);
    expect(w.waiting).toBe(true);
    expect(fingerprintCutNotes(w, { live: false, now: open })).toEqual([
      "Only 3m since the cut. First seen is against the hour before; Stopped waits for the after side to have that hour too.",
    ]);
  });

  test("Compare passes no minimum and keeps equal sides", () => {
    const w = cut(open - 18 * minute, { minBeforeMs: undefined });
    expect(w.beforeMs).toBe(18 * minute);
    expect(w.beforeFrom).toBe(open - 36 * minute);
    expect(w.waiting).toBe(false);
  });

  test("a closed incident band keeps equal sides: it will not grow into the hour", () => {
    const markTs = open - 3 * hour;
    const w = cut(markTs, { kind: "incident", markEndTs: markTs + 20 * minute });
    expect(w.banded).toBe(true);
    expect(w.beforeMs).toBe(20 * minute);
    expect(w.waiting).toBe(false);
  });
});

describe("marks inside the sides (#111)", () => {
  const at = (iso: string, title: string, side: "before" | "after", kind: "deploy" | "flag" = "deploy") => ({
    id: `mk_${title}`,
    kind,
    ts: iso,
    label: kind === "deploy" ? `deployed: api ${title}` : `flag: ${title}`,
    title,
    side,
  });
  const v092 = at("2026-10-16T10:05:13.000Z", "v0.9.2", "after");
  const v093 = at("2026-10-16T10:42:07.000Z", "v0.9.3", "after");

  test("names later deploys in one sentence a side", () => {
    expect(fingerprintCutInsideNotes([v092, v093])).toEqual([
      "Two more deploys are inside the after side. A first seen row's time says which one it follows.",
    ]);
    expect(fingerprintCutInsideNotes([at("2026-10-16T08:00:00.000Z", "scaler.v2", "before", "flag")])).toEqual([
      "One more flag is inside the before side.",
    ]);
    expect(
      fingerprintCutInsideNotes([v092, at("2026-10-16T10:20:00.000Z", "scaler.v2", "after", "flag")])[0],
    ).toStartWith("Two more marks are inside the after side.");
    expect(fingerprintCutInsideNotes([])).toEqual([]);
  });

  test("a first seen row says which later deploy it follows", () => {
    expect(fingerprintCutFollows([v092, v093], "2026-10-16T10:42:51.000Z")).toBe("after v0.9.3");
    expect(fingerprintCutFollows([v092, v093], "2026-10-16T10:05:40.000Z")).toBe("after v0.9.2");
    expect(fingerprintCutFollows([v092, v093], "2026-10-16T09:31:02.000Z")).toBe("");
    expect(fingerprintCutFollows([v092, v093], null)).toBe("");
  });
});

describe("naming marks over the cap (#111)", () => {
  test("keeps the marks nearest the cut, in time order", () => {
    const cut = Date.parse("2026-10-16T10:00:00.000Z");
    const m = (min: number) => ({
      id: `mk_${min}`,
      kind: "deploy" as const,
      ts: new Date(cut + min * 60_000).toISOString(),
      label: `deployed: api ${min}`,
      title: String(min),
      side: (min < 0 ? "before" : "after") as "before" | "after",
    });
    const all = [m(-55), m(-30), m(-5), m(4), m(12), m(40)];
    expect(nearestInsideMarks(all, cut, 4).map((x) => x.title)).toEqual(["-30", "-5", "4", "12"]);
    expect(nearestInsideMarks(all.slice(0, 3), cut, 4)).toHaveLength(3);
  });
});
