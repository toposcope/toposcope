import { describe, expect, test } from "bun:test";
import {
  capFingerprintCutSet,
  classifyFingerprintCut,
  fingerprintCutCap,
  fingerprintCutNotes,
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
