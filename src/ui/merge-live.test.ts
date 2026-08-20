import { describe, expect, test } from "bun:test";
import type { HistogramBucket, LogEvent } from "./types";
import {
  histogramTotal,
  mergeHistogramBuckets,
  mergeLiveEvents,
} from "./merge-live";

function event(ts: string, message: string): LogEvent {
  return { ts, service: "api", level: "info", message };
}

function bucket(t: string, n: number): HistogramBucket {
  return { t, n, series: { info: n }, by_level: { info: n } };
}

describe("mergeLiveEvents", () => {
  test("prepends new rows, drops duplicates and rows that left the window", () => {
    const prev = [
      event("2026-08-14T15:00:02.000Z", "b"),
      event("2026-08-14T15:00:01.000Z", "a"),
      event("2026-08-14T14:00:00.000Z", "old"),
    ];
    const incoming = [
      event("2026-08-14T15:00:03.000Z", "c"),
      event("2026-08-14T15:00:02.000Z", "b"),
    ];
    expect(
      mergeLiveEvents(prev, incoming, "2026-08-14T14:30:00.000Z", 10).map(
        (row) => row.message,
      ),
    ).toEqual(["c", "b", "a"]);
  });

  test("keeps the newest page when more than the limit arrive", () => {
    const prev = [event("2026-08-14T15:00:00.000Z", "old")];
    const incoming = [
      event("2026-08-14T15:00:02.000Z", "new"),
      event("2026-08-14T15:00:01.000Z", "mid"),
    ];
    expect(
      mergeLiveEvents(prev, incoming, "2026-08-14T14:00:00.000Z", 2).map(
        (row) => row.message,
      ),
    ).toEqual(["new", "mid"]);
  });

  test("keeps same-stamp rows that differ by request_id", () => {
    const older: LogEvent = {
      ts: "2026-08-16T23:43:14.857Z",
      service: "worker",
      host: "worker-1",
      level: "info",
      message: "user login live1786919122265",
      attrs: { request_id: "req-old" },
    };
    const incoming = [{ ...older, attrs: { request_id: "req-new" } }];
    expect(
      mergeLiveEvents([older], incoming, "2026-08-16T23:00:00.000Z", 10).map(
        (row) => row.attrs?.request_id,
      ),
    ).toEqual(["req-new", "req-old"]);
  });

  test("does not drop a Load-more tail on the next live poll", () => {
    const prev = [
      event("2026-08-14T15:00:04.000Z", "d"),
      event("2026-08-14T15:00:03.000Z", "c"),
      event("2026-08-14T15:00:02.000Z", "b"),
      event("2026-08-14T15:00:01.000Z", "a"),
    ];
    const incoming = [event("2026-08-14T15:00:05.000Z", "e")];
    expect(
      mergeLiveEvents(prev, incoming, "2026-08-14T14:00:00.000Z", 2).map(
        (row) => row.message,
      ),
    ).toEqual(["e", "d", "c", "b", "a"]);
  });
});

describe("mergeHistogramBuckets", () => {
  test("replaces overlapping minutes and keeps the rest", () => {
    const prev = [
      bucket("2026-08-14T14:58:00.000Z", 4),
      bucket("2026-08-14T14:59:00.000Z", 5),
    ];
    const incoming = [bucket("2026-08-14T14:59:00.000Z", 9)];
    expect(mergeHistogramBuckets(prev, incoming)).toEqual([
      bucket("2026-08-14T14:58:00.000Z", 4),
      bucket("2026-08-14T14:59:00.000Z", 9),
    ]);
    expect(histogramTotal(mergeHistogramBuckets(prev, incoming))).toBe(13);
  });
});
