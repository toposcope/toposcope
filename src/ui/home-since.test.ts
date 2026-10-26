import { describe, expect, test } from "bun:test";
import type { ChangeMark } from "../shared/change-mark";
import { deltaText, firstRunSteps, formatValue, markAge, resolvePick, sideText } from "./home-since";

const now = Date.parse("2026-10-26T13:26:00Z");
const m = (id: string): ChangeMark => ({ id, ts: "2026-10-26T12:48:00Z", end_ts: null, kind: "deploy", service: "", title: id, attrs: {} });

describe("Home's words (#259)", () => {
  test("delta text and colour", () => {
    expect(deltaText(0.009, 0.091, "rate")).toEqual({ text: "+8.2", up: true });
    expect(deltaText(0, 61, "count")).toEqual({ text: "new", up: true });
    expect(deltaText(188, 184, "count")).toEqual({ text: "−4", up: false });
    expect(deltaText(2, 2, "count")).toEqual({ text: "±0", up: false });
    expect(deltaText(null, 3, "count")).toEqual({ text: "—", up: false });
  });
  test("values", () => {
    expect(formatValue(0.091, "rate")).toBe("9.1%");
    expect(formatValue(1380, "p95 duration_ms")).toBe("1380");
    expect(formatValue(12345, "count")).toBe("12 345");
    expect(formatValue(null, "count")).toBe("—");
  });
  test("age and side", () => {
    expect(markAge("2026-10-26T12:48:00Z", now)).toBe("38 min ago");
    expect(markAge("2026-10-25T16:02:00Z", now)).toBe("21 h ago");
    expect(markAge("2026-10-25T10:02:00Z", now)).toBe("yesterday 10:02");
    expect(sideText(30 * 60_000)).toBe("30 min before → 30 min after");
    expect(sideText(60 * 60_000)).toBe("1 h before → 1 h after");
  });
  test("a clicked mark is kept until a newer deploy or flag arrives", () => {
    expect(resolvePick({ markId: "api", autoThen: "v0.9" }, "v0.9", [m("v0.9"), m("api")])).toBe("api");
    expect(resolvePick({ markId: "api", autoThen: "v0.9" }, "v0.10", [m("v0.10"), m("v0.9"), m("api")])).toBeNull();
    expect(resolvePick({ markId: "gone", autoThen: "v0.9" }, "v0.9", [m("v0.9")])).toBeNull();
    expect(resolvePick(null, "v0.9", [])).toBeNull();
  });
  test("first-run steps become done in order", () => {
    expect(firstRunSteps({ named: true, ingested: false, savedCount: 0, markCount: 0 })).toEqual([true, false, false]);
    expect(firstRunSteps({ named: true, ingested: true, savedCount: 1, markCount: 1 })).toEqual([true, true, true]);
  });
});
