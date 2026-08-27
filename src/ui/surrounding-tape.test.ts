import { describe, expect, test } from "bun:test";
import type { LogEvent } from "./types";
import { frozenQueryNote, markFocusNote, surroundingTape } from "./surrounding-tape";

function ev(ts: string, level: LogEvent["level"] = "info"): LogEvent {
  return { ts, service: "worker", level, message: "m" };
}

describe("surroundingTape", () => {
  test("anchor is the tall white tick; errors are red", () => {
    const anchor = ev("2026-08-16T15:00:30.000Z");
    const tape = surroundingTape(
      [
        ev("2026-08-16T15:00:00.000Z"),
        ev("2026-08-16T15:00:10.000Z", "error"),
        anchor,
        ev("2026-08-16T15:01:00.000Z", "warn"),
      ],
      anchor,
    );
    expect(tape.from).toBe("15:00:00");
    expect(tape.to).toBe("15:01:00");
    expect(tape.label).toBe("4 rows · 60s");
    expect(tape.ticks[2]).toMatchObject({ height: 24, width: 2, color: "oklch(0.985 0 0)" });
    expect(tape.ticks[1]?.height).toBe(15);
    expect(tape.ticks[3]?.height).toBe(12);
  });

  test("mark focus paints oldest left to newest right without a log at the mark", () => {
    const tape = surroundingTape(
      [
        ev("2026-08-25T16:29:34.000Z"),
        ev("2026-08-25T16:29:36.000Z"),
        ev("2026-08-25T16:29:38.000Z"),
        ev("2026-08-25T16:29:39.000Z"),
      ],
      { ts: "2026-08-25T16:29:37.732Z" },
    );
    expect(tape.from).toBe("16:29:34");
    expect(tape.to).toBe("16:29:39");
    expect(tape.ticks.map((tick) => tick.leftPct)).toEqual([0, 40, 80, 100]);
    expect(tape.ticks.every((tick) => tick.height !== 24)).toBe(true);
  });
});

describe("frozenQueryNote", () => {
  test("names the inherited query", () => {
    expect(frozenQueryNote("all", "level:error")).toContain("Frozen query · level:error");
    expect(frozenQueryNote("match", "level:error")).toContain("showing only rows matching");
  });
});

describe("markFocusNote", () => {
  test("names ±n around the mark without filtering the hunt query", () => {
    expect(markFocusNote("", 50)).toBe(
      "50 logs before this mark and 50 after, in the hunt window",
    );
    expect(markFocusNote("level:error", 50)).toContain("50 before and 50 after");
    expect(markFocusNote("level:error", 50)).toContain("nothing is filtered out");
    expect(markFocusNote("level:error", 100)).toBe(
      "Frozen query · level:error — 100 before and 100 after this mark, nothing is filtered out",
    );
  });
});
