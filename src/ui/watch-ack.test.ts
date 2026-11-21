import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WatchView } from "./components/watch-view";
import type { MonitorStretch, MonitorView, MonitorsResponse } from "./types";
import { ackedLine, checksLine, checksTitle, isAcked, nowTitle, sortForWatch, watchCounts, watchDot } from "./watch";

const minute = 60_000;
const hour = 60 * minute;
const now = Date.parse("2026-10-20T11:03:00.000Z");
const dayAgo = now - 24 * hour;

const stretch = (over: Partial<MonitorStretch> = {}): MonitorStretch => ({
  id: "st-1",
  monitor_id: "m-quiet",
  opened_at: now - 22 * minute,
  resolved_at: null,
  closed_by: null,
  open_value: 57,
  open_message: "Count 57 ≥ 50",
  last_value: 61,
  last_at: now,
  called_at: now - 22 * minute,
  open_call: "sent",
  resolved_call: null,
  calls: [],
  ...over,
});

const monitor = (over: Partial<MonitorView> = {}): MonitorView => ({
  id: "m-errors",
  name: "api errors",
  service: "api",
  host: "",
  kind: "threshold",
  source: "search",
  state: "ok",
  enabled: 1,
  remind_every: "4h",
  resolved_body: null,
  last_mark: null,
  body_kind: "default",
  body_template: null,
  saved_search_id: "s1",
  threshold: 50,
  webhook_url: "https://ntfy.sh/payroll-ops",
  last_fired_at: null,
  last_attempt_at: null,
  last_status: null,
  last_error: null,
  consecutive_failures: 0,
  silenced_until: null,
  last_result: "ok",
  last_value: 12,
  last_result_at: now - minute,
  saved: { id: "s1", name: "api errors", query: "service:api level:error", range: "15m", agg: null },
  open: null,
  ...over,
});

const errors = monitor();
const quiet = monitor({
  id: "m-quiet",
  name: "ci-box lines loud",
  service: "ci",
  host: "ci-box",
  threshold: 1,
  state: "open",
  saved: { id: "s2", name: "ci-box lines", query: "host:ci-box", range: "15m", agg: null },
  open: stretch(),
});
const fingerprints = monitor({ id: "m-fp", name: "after a deploy", kind: "first_seen", source: "fingerprints", threshold: 1 });
const acked = monitor({
  id: "m-acked",
  name: "event loop stalls",
  state: "open",
  open: stretch({ id: "st-2", monitor_id: "m-acked", opened_at: now - 14 * hour - 47 * minute, acked_at: now - hour, acked_by: "p1" }),
  acked: { at: now - hour, by: { id: "p1", name: "Maya K.", revoked: false, kind: "person" } },
});

describe("acknowledge (50g)", () => {
  test("an acknowledged monitor leaves the open count, draws a grey dot and sorts after the open", () => {
    expect(isAcked(acked)).toBe(true);
    expect(isAcked(quiet)).toBe(false);
    expect(watchCounts([errors, quiet, acked])).toEqual({ open: 1, late: 0, warn: 0 });
    expect(watchCounts([acked])).toEqual({ open: 0, late: 0, warn: 0 });
    expect(watchDot(acked)).toBe("acked");
    expect(watchDot(quiet)).toBe("open");
    expect(sortForWatch([errors, acked, quiet]).map((m) => m.id)).toEqual(["m-quiet", "m-acked", "m-errors"]);
    // Resolved, it is not acknowledged, whatever a stale field says.
    expect(isAcked({ ...acked, state: "ok" })).toBe(false);
  });

  test("now says who has it and how long it has been open; its tooltip keeps the state line and last check", () => {
    expect(ackedLine(acked, now)).toBe("acked by Maya K. · 14h 47m");
    expect(ackedLine(quiet, now)).toBeNull();
    expect(ackedLine({ ...acked, acked: { at: now, by: null } }, now)).toBe("acked · 14h 47m");
    expect(nowTitle(acked, [], now, now - minute).split("\n")).toEqual([
      "open since 10-19 20:16 · 14h 47m",
      "acknowledged by Maya K. at 10:03 · no reminders until it resolves",
      "last check 11:02",
    ]);
    const resolved = stretch({ id: "old", monitor_id: "m-errors", opened_at: now - 18 * hour, resolved_at: now - 17 * hour, closed_by: "ok" });
    expect(nowTitle(errors, [resolved], now, null)).toBe("ok · last open 10-19 17:03 for 1h\nlast check —");
  });
});

describe("one line per monitor (50g)", () => {
  test("checks are shown once, short, and in full in their tooltip", () => {
    expect(checksLine(quiet)).toBe("host:ci-box · ≥ 1 in 15m");
    expect(checksLine(monitor({ opens_when: "fewer_than", threshold: 1 }))).toBe("service:api level:error · < 1 in 15m");
    expect(checksLine(fingerprints)).toBe("service:api level:error · new after a deploy or flag");
    const http = monitor({ source: "http", http: { url: "https://api.example.com/health", method: "GET", conditions: "" } as MonitorView["http"] });
    expect(checksLine(http)).toBe("GET api.example.com/health · any 2xx");
    expect(checksTitle(quiet, now).split("\n")).toEqual(["search · host:ci-box · at least 1 line in 15m", "search · at least 1 · 15m"]);
  });

  test("an open monitor has Acknowledge; an acknowledged one says who; a Viewer sees no button", () => {
    const data: MonitorsResponse = {
      now,
      from: new Date(dayAgo).toISOString(),
      to: new Date(now).toISOString(),
      monitors: [errors, quiet, acked],
      stretches: [quiet.open!, acked.open!],
      sent: [],
      link: false,
    };
    const props = { data, range: "24h" as const, onRange: () => {}, filter: "all" as const, onFilter: () => {}, marks: [], onNew: () => {}, onOpen: () => {} };
    const html = renderToStaticMarkup(createElement(WatchView, { ...props, canCreate: true, onAck: () => {} }));
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text).toContain("Watch 3 monitors · 1 open");
    expect(text).toContain("ci-box lines loud ci ci-box host:ci-box · ≥ 1 in 15m Acknowledge open 22m");
    expect(text).toContain("event loop stalls api service:api level:error · ≥ 50 in 15m acked by Maya K. · 14h 47m");
    expect(html.match(/>Acknowledge</g)?.length).toBe(1);
    expect(html).toContain('aria-label="acked"');
    // The open since line is in now's tooltip, not under the name.
    expect(text).not.toContain("open since");
    const viewer = renderToStaticMarkup(createElement(WatchView, { ...props, canCreate: false }));
    expect(viewer).not.toContain(">Acknowledge<");
    expect(viewer).toContain("acked by Maya K.");
  });
});
