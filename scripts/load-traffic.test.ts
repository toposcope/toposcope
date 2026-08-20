import { describe, expect, test } from "bun:test";
import {
  attachKeptLog,
  KEPT_RING,
  liveLogEvents,
  liveMetricPoints,
  liveTraceId,
  liveTraceTree,
  pushKept,
} from "./load-traffic";

describe("liveTraceId", () => {
  test("is 32 hex and not all zeros", () => {
    expect(liveTraceId(0)).toMatch(/^[0-9a-f]{32}$/);
    expect(liveTraceId(0)).not.toMatch(/^0+$/);
    expect(liveTraceId(1)).not.toBe(liveTraceId(2));
  });
});

describe("liveLogEvents", () => {
  test("stamps joinable and sampled-out ids", () => {
    const kept = ["aa".padEnd(32, "b")];
    const planned = liveLogEvents({
      start: 0,
      count: 64,
      now: Date.parse("2026-08-16T15:00:00.000Z"),
      marker: "live-test",
      keptIds: kept,
    });
    expect(planned.events).toHaveLength(64);
    expect(planned.events.every((event) => event.message.includes("live-test"))).toBe(
      true,
    );
    expect(planned.joinable.length + planned.sampledOut.length).toBeGreaterThan(0);
    expect(planned.joinable.length).toBeGreaterThan(planned.sampledOut.length);
    expect(planned.sampledOut.length).toBeGreaterThan(0);
    expect(planned.sampledOut.every((id) => id.length === 32)).toBe(true);
  });
});

describe("liveTraceTree", () => {
  test("is a 3-span parent chain", () => {
    const spans = liveTraceTree(3, Date.parse("2026-08-16T15:00:00.000Z"));
    expect(spans).toHaveLength(3);
    expect(spans[1]?.parent_span_id).toBe(spans[0]?.span_id);
    expect(spans[2]?.parent_span_id).toBe(spans[1]?.span_id);
    expect(new Set(spans.map((span) => span.trace_id)).size).toBe(1);
  });
});

describe("liveMetricPoints", () => {
  test("stays on cpu_seconds with optional service", () => {
    const points = liveMetricPoints({ start: 0, count: 20, now: Date.now() });
    expect(points.every((point) => point.name === "cpu_seconds")).toBe(true);
    expect(points.some((point) => point.labels === undefined)).toBe(true);
    expect(points.some((point) => point.labels?.service)).toBe(true);
  });
});

describe("pushKept / attachKeptLog", () => {
  test("rings and stamps the last log", () => {
    let kept: string[] = [];
    for (let i = 0; i < KEPT_RING + 2; i++) {
      kept = pushKept(kept, liveTraceId(i));
    }
    expect(kept).toHaveLength(KEPT_RING);
    const planned = liveLogEvents({
      start: 0,
      count: 1,
      now: Date.now(),
      marker: "m",
      keptIds: kept,
    });
    expect(attachKeptLog(planned.events, kept[kept.length - 1])).toBe(true);
    expect(planned.events[0]?.attrs.trace_id).toBe(kept[kept.length - 1]);
  });
});
