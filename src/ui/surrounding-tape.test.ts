import { describe, expect, test } from "bun:test";
import type { LogEvent } from "./types";
import { frozenQueryNote, surroundingTape } from "./surrounding-tape";

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
});

describe("frozenQueryNote", () => {
  test("names the inherited query", () => {
    expect(frozenQueryNote("all", "level:error")).toContain("Frozen query · level:error");
    expect(frozenQueryNote("match", "level:error")).toContain("showing only rows matching");
  });
});
