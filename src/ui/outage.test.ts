import { describe, expect, test } from "bun:test";
import {
  afterProbe,
  classifyHealth,
  isOwnApi,
  outageScreen,
  probeResult,
  retryWaitMs,
  screenAfterMs,
  type OutageState,
} from "./outage";
import type { Health } from "../shared/boot";

const ready: Health = { ok: true, phase: "ready", clickhouse: true, sqlite: true, version: "0.11.1" };

describe("outage (33i–33l)", () => {
  test("retry waits climb 2 → 4 → 8 → 15 → 30 s, then stay at 30 s", () => {
    expect([1, 2, 3, 4, 5, 6, 40].map(retryWaitMs)).toEqual([2_000, 4_000, 8_000, 15_000, 30_000, 30_000, 30_000]);
  });

  test("health says which side is down", () => {
    expect(classifyHealth(ready)).toEqual({ ok: true });
    expect(classifyHealth(null)).toMatchObject({ ok: false, kind: "app", phase: null });
    expect(classifyHealth({ ...ready, ok: false, clickhouse: false })).toMatchObject({ ok: false, kind: "clickhouse" });
    expect(classifyHealth({ ...ready, ok: false, phase: "schema" })).toMatchObject({ ok: false, kind: "app", phase: "schema" });
  });

  test("a failed probe opens an outage, and later ones keep its start and count attempts", () => {
    const first = afterProbe({ status: "ok" }, classifyHealth(null), 1_000, null);
    expect(first).toMatchObject({ status: "down", kind: "app", since: 1_000, attempt: 1, nextAt: 3_000 });
    const second = afterProbe(first, classifyHealth(null), 3_000, null);
    expect(second).toMatchObject({ status: "down", since: 1_000, attempt: 2, nextAt: 7_000 });
  });

  test("ClickHouse down carries the last failed call's error; the app down does not", () => {
    const ch = afterProbe({ status: "ok" }, classifyHealth({ ...ready, ok: false, clickhouse: false }), 0, "connect ECONNREFUSED");
    expect(ch).toMatchObject({ kind: "clickhouse", detail: "connect ECONNREFUSED" });
    expect(afterProbe({ status: "ok" }, classifyHealth(null), 0, "connect ECONNREFUSED")).toMatchObject({ kind: "app", detail: null });
  });

  test("a passing probe after an outage is back, with how long it was down", () => {
    const down = afterProbe({ status: "ok" }, classifyHealth(null), 10_000, null);
    expect(afterProbe(down, { ok: true }, 52_000, null)).toEqual({ status: "back", downMs: 42_000, at: 52_000 });
  });

  test("a passing probe with nothing down changes nothing (a 500 from a bug stays the caller's)", () => {
    const ok: OutageState = { status: "ok" };
    expect(afterProbe(ok, { ok: true }, 5, null)).toBe(ok);
  });

  test("a timed-out probe keeps a known cause; an unknown one is the app", () => {
    const ch = afterProbe({ status: "ok" }, classifyHealth({ ...ready, ok: false, clickhouse: false }), 0, null);
    expect(probeResult(ch, null, true)).toMatchObject({ ok: false, kind: "clickhouse" });
    expect(probeResult(ch, null, false)).toMatchObject({ ok: false, kind: "app" });
    expect(probeResult({ status: "ok" }, null, true)).toMatchObject({ ok: false, kind: "app" });
  });

  test("the band holds the last paint for the first 15 s, then the full screen", () => {
    const down = afterProbe({ status: "ok" }, classifyHealth(null), 0, null);
    expect(outageScreen(down, screenAfterMs - 1)).toBe(false);
    expect(outageScreen(down, screenAfterMs)).toBe(true);
    expect(outageScreen({ status: "back", downMs: 1, at: 0 }, 99_999)).toBe(false);
  });

  test("only this origin's /api/ calls count, and never the health probe itself", () => {
    const origin = "https://logs.example.com";
    expect(isOwnApi("/api/search?q=", origin)).toBe(true);
    expect(isOwnApi("https://logs.example.com/api/system", origin)).toBe(true);
    expect(isOwnApi("/api/health", origin)).toBe(false);
    expect(isOwnApi("/v1/logs", origin)).toBe(false);
    expect(isOwnApi("https://hooks.slack.com/api/x", origin)).toBe(false);
  });
});
