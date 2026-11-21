import { describe, expect, test } from "bun:test";
import type { ChangeMark } from "../shared/change-mark";
import { agoText, deltaText, fingerprintsTitle, firstRunSteps, formatValue, valueUnit, valueWithUnit, markStrip, markWhen, marksNewestFirst, resolvePick, sideText } from "./home-since";

const now = Date.parse("2026-10-26T13:26:00Z");
const m = (id: string): ChangeMark => ({ id, ts: "2026-10-26T12:48:00Z", end_ts: null, kind: "deploy", service: "", title: id, attrs: {} });
const at = (id: string, minutesAgo: number): ChangeMark => ({ ...m(id), ts: new Date(now - minutesAgo * 60_000).toISOString() });

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
    expect(agoText("2026-10-26T13:26:20Z", now)).toBe("just now");
    expect(agoText("2026-10-26T12:48:00Z", now)).toBe("38 min ago");
    expect(agoText("2026-10-25T16:02:00Z", now)).toBe("21 h ago");
    expect(agoText("2026-10-23T13:26:00Z", now)).toBe("3 d ago");
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

describe("Home's Since bar (49b)", () => {
  test("a mark's time: HH:MM today, yesterday HH:MM, else a short date, all UTC", () => {
    expect(markWhen("2026-10-26T00:05:00Z", now)).toBe("00:05");
    expect(markWhen("2026-10-25T16:22:00Z", now)).toBe("yesterday 16:22");
    expect(markWhen("2026-10-18T09:00:00Z", now)).toBe("Oct 18");
    expect(markWhen("2026-10-18T09:00:00Z", now, true)).toBe("Oct 18 09:00");
  });

  test("marks come newest first whatever order the API sent", () => {
    expect(marksNewestFirst([at("old", 300), at("new", 5), at("mid", 60)]).map((x) => x.id)).toEqual(["new", "mid", "old"]);
  });

  test("four chips, newest first; the rest are earlier, and their count is right", () => {
    const marks = Array.from({ length: 17 }, (_, i) => at(`m${i}`, 10 + i * 30)).reverse();
    const strip = markStrip(marks, "m0");
    expect(strip.chips.map((x) => x.id)).toEqual(["m0", "m1", "m2", "m3"]);
    expect(strip.earlier.length).toBe(13);
    expect(strip.earlier[0]!.id).toBe("m4");
  });

  test("a mark picked from the earlier menu takes the last chip", () => {
    const marks = Array.from({ length: 8 }, (_, i) => at(`m${i}`, 10 + i * 30));
    const strip = markStrip(marks, "m6");
    expect(strip.chips.map((x) => x.id)).toEqual(["m0", "m1", "m2", "m6"]);
    expect(strip.earlier.map((x) => x.id)).toEqual(["m3", "m4", "m5", "m7"]);
  });

  test("four or fewer marks: no earlier menu", () => {
    const strip = markStrip([at("a", 1), at("b", 2)], null);
    expect(strip.chips.map((x) => x.id)).toEqual(["a", "b"]);
    expect(strip.earlier).toEqual([]);
  });
});

describe("New fingerprints title", () => {
  test("counts stopped rows too", () => {
    expect(fingerprintsTitle(null)).toBe("New fingerprints · none");
    expect(fingerprintsTitle({ first_seen: [], stopped: [{}], more: 0 })).toBe("New fingerprints · 0 · 1 stopped");
    expect(fingerprintsTitle({ first_seen: [{}, {}], stopped: [], more: 3 })).toBe("New fingerprints · 2+");
  });
});

describe("a value's unit", () => {
  test("comes from the field the measure reads", () => {
    expect(valueUnit("p99 duration_ms")).toBe("ms");
    expect(valueUnit("p99(duration_ms)")).toBe("ms");
    expect(valueUnit("sum(response_bytes)")).toBe("B");
    expect(valueUnit("avg latency_us")).toBe("us");
    expect(valueUnit("max took_seconds")).toBe("s");
    expect(valueUnit("sum bytes")).toBe("B");
    expect(valueUnit("sum response_bytes")).toBe("B");
  });

  test("a count, a rate, or a name that says none has none", () => {
    for (const kind of ["count", "rate", "p99(status)", "p99 status", "avg items", "max class", "sum address"]) {
      expect(valueUnit(kind)).toBe("");
    }
  });

  test("is printed once, and never on a missing value", () => {
    expect(valueWithUnit(1470, "p99 duration_ms")).toBe("1470 ms");
    expect(valueWithUnit(12, "count")).toBe("12");
    expect(valueWithUnit(null, "p99 duration_ms")).toBe("—");
  });
});
