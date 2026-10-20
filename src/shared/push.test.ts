import { describe, expect, test } from "bun:test";
import {
  defaultGraceMs,
  exitCodeOfStatus,
  formatSpan,
  isLate,
  isPingKey,
  levelOfStatus,
  maskKey,
  randomPingKey,
  monitorQuery,
  parseCheckStatus,
  parseEvery,
  parseGrace,
  parsePushName,
  pingStatusOfExitCode,
  pushDueAt,
  pushOpensAt,
  type PushClock,
} from "./push";

const minute = 60_000;
const hour = 60 * minute;

describe("a result's status (#177)", () => {
  test("ok, warn or fail, or Nagios's 0–3 as a number or its digit", () => {
    expect(["ok", "warn", "fail"].map(parseCheckStatus)).toEqual(["ok", "warn", "fail"]);
    expect([0, 1, 2, 3].map(parseCheckStatus)).toEqual(["ok", "warn", "fail", "unknown"]);
    expect(["0", "1", "2", "3"].map(parseCheckStatus)).toEqual(["ok", "warn", "fail", "unknown"]);
  });

  test("anything else is refused, unknown as a word too", () => {
    for (const raw of ["unknown", "OK", "critical", 4, -1, 1.5, "02", "", null, undefined, true]) {
      expect(parseCheckStatus(raw)).toBeNull();
    }
  });

  test("a numeric status is the row's exit code; a word is not", () => {
    expect(exitCodeOfStatus(2)).toBe(2);
    expect(exitCodeOfStatus("3")).toBe(3);
    expect(exitCodeOfStatus("fail")).toBeNull();
  });

  test("a ping's exit code is Healthchecks': 0 ok, anything else a fail", () => {
    expect(pingStatusOfExitCode(0)).toBe("ok");
    expect(pingStatusOfExitCode(1)).toBe("fail");
    expect(pingStatusOfExitCode(255)).toBe("fail");
  });

  test("a fail is an error row, a warn a warn, the rest info", () => {
    expect(levelOfStatus("fail")).toBe("error");
    expect(levelOfStatus("warn")).toBe("warn");
    expect(levelOfStatus("ok")).toBe("info");
    expect(levelOfStatus("unknown")).toBe("info");
  });
});

describe("every and grace", () => {
  test("every is 30s to 365d", () => {
    expect(parseEvery("5m")).toBe(5 * minute);
    expect(parseEvery("1d")).toBe(24 * hour);
    expect(parseEvery("30s")).toBe(30_000);
    expect(parseEvery("10s")).toBeNull();
    expect(parseEvery("366d")).toBeNull();
    expect(parseEvery("0")).toBeNull();
    expect(parseEvery(300)).toBeNull();
  });

  test("grace may be 0", () => {
    expect(parseGrace("2m")).toBe(2 * minute);
    expect(parseGrace("0")).toBe(0);
    expect(parseGrace("0s")).toBe(0);
    expect(parseGrace("soon")).toBeNull();
  });

  test("without a grace, one more every, at most an hour", () => {
    expect(defaultGraceMs(5 * minute)).toBe(5 * minute);
    expect(defaultGraceMs(24 * hour)).toBe(hour);
  });

  test("a span says its largest whole unit", () => {
    expect(formatSpan(24 * hour)).toBe("1d");
    expect(formatSpan(15 * minute)).toBe("15m");
    expect(formatSpan(90 * minute)).toBe("90m");
    expect(formatSpan(7 * 24 * hour)).toBe("7d");
    expect(formatSpan(0)).toBe("0");
  });
});

describe("a push monitor's clock", () => {
  const t0 = Date.parse("2026-10-20T10:00:00.000Z");
  const clock = (over: Partial<PushClock> = {}): PushClock => ({
    enabled: 1,
    state: "ok",
    every_ms: hour,
    grace_ms: 15 * minute,
    due_from: t0,
    created_at: t0 - hour,
    started_at: null,
    ...over,
  });

  test("with every 1h and grace 15m, it is late at 1h and opens at 1h15m", () => {
    expect(pushDueAt(clock())).toBe(t0 + hour);
    expect(pushOpensAt(clock())).toBe(t0 + hour + 15 * minute);
    expect(isLate(clock(), t0 + hour)).toBe(false);
    expect(isLate(clock(), t0 + hour + 1)).toBe(true);
  });

  test("without every it is never due, so never late", () => {
    expect(pushDueAt(clock({ every_ms: null }))).toBeNull();
    expect(isLate(clock({ every_ms: null }), t0 + 365 * 24 * hour)).toBe(false);
  });

  test("paused or open is not late", () => {
    expect(isLate(clock({ enabled: 0 }), t0 + 2 * hour)).toBe(false);
    expect(isLate(clock({ state: "open" }), t0 + 2 * hour)).toBe(false);
  });

  test("before any result it counts from when it was made", () => {
    expect(pushDueAt(clock({ due_from: null }))).toBe(t0);
  });
});

describe("names and keys", () => {
  test("a name is what monitor:<name> finds, quoted when it needs to be", () => {
    expect(monitorQuery("nightly-backup")).toBe("monitor:nightly-backup");
    expect(monitorQuery("ci-runner check")).toBe('monitor:"ci-runner check"');
    expect(monitorQuery("-x")).toBe('monitor:"-x"');
    expect(monitorQuery(">5")).toBe('monitor:">5"');
    expect(monitorQuery("disk*")).toBe('monitor:"disk*"');
  });

  test("a name has no quote and no control character, and is at most 100 characters", () => {
    expect(parsePushName("  disk-var ")).toBe("disk-var");
    expect(parsePushName('say "hi"')).toEqual({ error: "monitor must have no quote and no control character" });
    expect(parsePushName("a\nb")).toEqual({ error: "monitor must have no quote and no control character" });
    expect(parsePushName("x".repeat(101))).toEqual({ error: "monitor must be at most 100 characters" });
    expect(parsePushName("")).toEqual({ error: "monitor is required" });
  });

  test("a key is a random UUID, and is shown masked", () => {
    const key = crypto.randomUUID();
    expect(isPingKey(key)).toBe(true);
    expect(isPingKey("00000000-0000-0000-0000-000000000000")).toBe(false);
    expect(isPingKey(key.toUpperCase())).toBe(false);
    expect(maskKey("9f2c1111-2222-4333-8444-55555555e41a")).toBe("9f2c…e41a");
    const keys = new Set(Array.from({ length: 50 }, randomPingKey));
    expect(keys.size).toBe(50);
    expect([...keys].every(isPingKey)).toBe(true);
  });
});
