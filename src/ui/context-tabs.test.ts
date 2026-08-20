import { describe, expect, test } from "bun:test";
import {
  contextTabLabel,
  maxContextTabs,
  reAnchorContextTab,
  upsertContextTab,
} from "./context-tabs";
import type { LogEvent } from "./types";

function ev(ts: string, service: string, message = "m"): LogEvent {
  return {
    ts,
    service,
    level: "info",
    message,
  };
}

describe("upsertContextTab", () => {
  test("moves an existing event to the end and caps at 5", () => {
    const a = ev("2026-08-14T15:00:00.000Z", "api");
    const tabs = [
      ev("2026-08-14T15:01:00.000Z", "api", "1"),
      ev("2026-08-14T15:02:00.000Z", "worker", "2"),
      a,
      ev("2026-08-14T15:04:00.000Z", "api", "4"),
      ev("2026-08-14T15:05:00.000Z", "api", "5"),
    ];
    const next = upsertContextTab(tabs, a);
    expect(next).toHaveLength(5);
    expect(next[4]).toEqual(a);
    expect(next.filter((tab) => tab.ts === a.ts)).toHaveLength(1);

    const sixth = ev("2026-08-14T15:06:00.000Z", "web");
    const capped = upsertContextTab(next, sixth);
    expect(capped).toHaveLength(maxContextTabs);
    expect(capped[4]).toEqual(sixth);
    expect(capped[0]?.message).toBe("2");
  });
});

describe("reAnchorContextTab", () => {
  test("replaces the current tab in place without reordering", () => {
    const a = ev("2026-08-14T15:00:00.000Z", "api");
    const b = ev("2026-08-14T15:01:00.000Z", "worker");
    const neighbor = ev("2026-08-14T15:00:01.000Z", "api");
    const next = reAnchorContextTab([a, b], a, neighbor);
    expect(next).toEqual([neighbor, b]);
  });

  test("switches to a tab that is already open", () => {
    const a = ev("2026-08-14T15:00:00.000Z", "api");
    const b = ev("2026-08-14T15:01:00.000Z", "worker");
    expect(reAnchorContextTab([a, b], a, b)).toEqual([a, b]);
  });

  test("upserts when the current tab is missing", () => {
    const a = ev("2026-08-14T15:00:00.000Z", "api");
    const neighbor = ev("2026-08-14T15:00:01.000Z", "api");
    expect(reAnchorContextTab([], null, neighbor)).toEqual([neighbor]);
    expect(reAnchorContextTab([a], null, neighbor)).toEqual([a, neighbor]);
  });
});

describe("contextTabLabel", () => {
  test("uses clock time and service", () => {
    expect(contextTabLabel(ev("2026-08-14T15:02:03.000Z", "api"))).toBe(
      "15:02:03 · api",
    );
  });
});
