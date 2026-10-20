import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChangeMark } from "../shared/change-mark";
import { MonitorRail } from "./components/monitor-rail";
import { WatchView } from "./components/watch-view";
import { eventTableMarkLayout } from "./change-marks";
import type { MonitorCall, MonitorStretch, MonitorView, MonitorsResponse, PushResultRow } from "./types";
import {
  callLine,
  pushBands,
  pushDueLine,
  pushHuntRange,
  pushReadout,
  pushTicks,
  resultCard,
  laneKind,
  laneReadout,
  markBefore,
  monitorHuntRange,
  nextReminder,
  openCardLine,
  sortForWatch,
  stretchSpans,
  watchCounts,
  watchFilters,
  watchTicks,
} from "./watch";

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

const call = (over: Partial<MonitorCall> = {}): MonitorCall => ({
  id: 1,
  monitor_id: "m-quiet",
  stretch_id: "st-1",
  at: now - 22 * minute,
  what: "open",
  status: "200",
  ok: true,
  error: null,
  ...over,
});

const monitor = (over: Partial<MonitorView> = {}): MonitorView => ({
  id: "m-errors",
  name: "api errors",
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
  webhook_url: "https://ntfy.sh/agental-ops",
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

const quiet = monitor({
  id: "m-quiet",
  name: "ci-box lines loud",
  threshold: 1,
  state: "open",
  remind_every: "window",
  saved: { id: "s2", name: "ci-box lines", query: "host:ci-box", range: "15m", agg: null },
  open: stretch({ calls: [call()] }),
});
const errors = monitor();
const fingerprints = monitor({
  id: "m-fp",
  name: "after a deploy",
  kind: "first_seen",
  source: "fingerprints",
  threshold: 1,
  last_value: null,
});

const mark = (id: string, ts: number, over: Partial<ChangeMark> = {}): ChangeMark => ({
  id,
  ts: new Date(ts).toISOString(),
  end_ts: null,
  kind: "deploy",
  service: "api",
  title: id,
  attrs: {},
  ...over,
});

describe("Watch's lanes (#175, frame 18c)", () => {
  test("open ones first, and the header counts them", () => {
    expect(sortForWatch([errors, fingerprints, quiet]).map((m) => m.id)).toEqual(["m-quiet", "m-errors", "m-fp"]);
    expect(watchCounts([errors, fingerprints, quiet])).toEqual({ open: 1, late: 0, warn: 0 });
    expect(watchCounts([monitor({ last_result: "warn" })])).toEqual({ open: 0, late: 0, warn: 1 });
  });

  test("the segments name each source a monitor has", () => {
    expect(watchFilters([errors, fingerprints, quiet])).toEqual([
      { id: "all", label: "All", n: 3 },
      { id: "search", label: "Search", n: 2 },
      { id: "fingerprints", label: "Fingerprints", n: 1 },
    ]);
    expect(watchFilters([errors]).map((f) => f.id)).toEqual(["all", "search"]);
  });

  test("each lane says what it watches, and what it last read", () => {
    expect(laneKind(errors)).toBe("search · at least 50 · 15m");
    expect(laneKind(monitor({ saved: { id: "s", name: "p99", query: "", range: "1h", agg: "p99:duration_ms" }, threshold: 800 }))).toBe(
      "search · p99(duration_ms) at least 800 · 1h",
    );
    expect(laneKind(fingerprints)).toBe("fingerprints · 24h");
    expect(openCardLine(quiet)).toBe("search · host:ci-box · at least 1 line in 15m");
    expect(laneReadout(quiet, now, 0)).toEqual({ badge: "open 22m", tone: "red", text: "" });
    expect(laneReadout(errors, now, 0)).toEqual({ badge: "ok", tone: "sec", text: "12" });
    expect(laneReadout(fingerprints, now, 2)).toEqual({ badge: "ok", tone: "sec", text: "2 sent" });
    expect(laneReadout(monitor({ last_status: "refused" }), now, 0).text).toBe("refused");
    expect(laneReadout(monitor({ enabled: 0 }), now, 0).badge).toBe("paused");
    expect(laneReadout(monitor({ silenced_until: now + hour }), now, 0).text).toBe("12 · silenced");
  });

  test("a stretch is a span of its lane: clipped to the clock, never thinner than a sliver", () => {
    const spans = stretchSpans(
      [
        stretch({ id: "a", opened_at: dayAgo - hour, resolved_at: dayAgo + hour }),
        stretch({ id: "b", opened_at: now - 12 * hour, resolved_at: now - 12 * hour + minute }),
        stretch({ id: "c" }),
        stretch({ id: "gone", opened_at: dayAgo - 3 * hour, resolved_at: dayAgo - 2 * hour }),
      ],
      dayAgo,
      now,
      now,
    );
    expect(spans.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(spans[0]!.left).toBe(0);
    expect(spans[0]!.width).toBeCloseTo(1 / 24, 5);
    expect(spans[1]!.width).toBeCloseTo(0.006, 5);
    expect(spans[2]).toMatchObject({ open: true });
    expect(spans[2]!.left + spans[2]!.width).toBeCloseTo(1, 5);
  });

  test("the clock reads every 3h, a midnight by its date", () => {
    const labels = watchTicks(dayAgo, now, "24h").map((t) => t.label);
    expect(labels).toEqual(["12:00", "15:00", "18:00", "21:00", "10-20", "03:00", "06:00", "09:00"]);
    expect(watchTicks(now - 7 * 24 * hour, now, "7d").map((t) => t.label)).toEqual([
      "10-14",
      "10-15",
      "10-16",
      "10-17",
      "10-18",
      "10-19",
      "10-20",
    ]);
  });

  test("Watch draws open cards, lanes and the marks row", () => {
    const data: MonitorsResponse = {
      now,
      from: new Date(dayAgo).toISOString(),
      to: new Date(now).toISOString(),
      monitors: [errors, fingerprints, quiet],
      stretches: [quiet.open!, stretch({ id: "old", monitor_id: "m-errors", opened_at: now - 18 * hour, resolved_at: now - 17 * hour, closed_by: "ok" })],
      sent: [call({ id: 7, monitor_id: "m-fp", stretch_id: null, what: "sent", at: now - 3 * hour })],
      link: false,
    };
    const html = renderToStaticMarkup(
      createElement(WatchView, {
        data,
        canCreate: true,
        range: "24h",
        onRange: () => {},
        filter: "all",
        onFilter: () => {},
        marks: [mark("v0.9.2", now - 19 * hour), mark("v0.9.3", now - 20 * minute)],
        onNew: () => {},
        onOpen: () => {},
      }),
    );
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text).toContain("Watch All 3 Search 2 Fingerprints 1 24h 7d 30d New monitor");
    expect(text).toContain("ci-box lines loud · open 22m search · host:ci-box · at least 1 line in 15m Open in Search");
    expect(text).toContain("now 11:03");
    // Lanes in order: the open one first.
    expect(text.indexOf("ci-box lines loud search · at least 1 · 15m open 22m")).toBeGreaterThan(-1);
    expect(text).toContain("api errors search · at least 50 · 15m ok 12");
    expect(text).toContain("after a deploy fingerprints · 24h ok 1 sent");
    expect(text).toContain("marks deploys and flags");
    expect(text).toContain("2 marks");
    // One open stretch, bright; one resolved, dim.
    expect(html.match(/bottom-\[3px\] bg-red-500"/g)?.length).toBe(1);
    expect(html.match(/bottom-\[3px\] rounded-\[2px\] bg-red-500\/45/g)?.length).toBe(1);
  });
});

describe("a stretch, read on the hunt clock (#175, frame 18o)", () => {
  test("its calls, and the next reminder while open", () => {
    expect(callLine(call(), "ntfy.sh", now)).toBe("10:41 open · ntfy 200");
    expect(callLine(call({ status: "silenced", ok: false }), "ntfy.sh", now)).toBe("10:41 open · silenced");
    expect(callLine(call({ what: "resolved" }), "hooks.slack.com", now)).toBe("10:41 resolved · slack 200");
    expect(callLine(call(), "127.0.0.1:28090", now)).toBe("10:41 open · 127.0.0.1:28090 200");
    // Every window (15m) since 10:41 is due now.
    expect(nextReminder(quiet, now)).toBe(now);
    expect(nextReminder({ ...quiet, remind_every: "4h" }, now)).toBe(now - 22 * minute + 4 * hour);
    expect(nextReminder({ ...quiet, remind_every: "off" }, now)).toBeNull();
  });

  test("the deploy before it", () => {
    const marks = [mark("v0.9.2", now - 19 * hour), mark("v0.9.3", now - 20 * minute), mark("note", now - 30 * minute, { kind: "note" })];
    expect(markBefore(marks, null, now - 22 * minute)?.id).toBe("v0.9.2");
    expect(markBefore(marks, null, now)?.id).toBe("v0.9.3");
    expect(markBefore([], mark("older", now - 30 * hour), now)?.id).toBe("older");
  });

  test("the row where it opened sits among the events by time", () => {
    const events = [{ ts: new Date(now - 10 * minute).toISOString() }, { ts: new Date(now - 30 * minute).toISOString() }];
    const layout = eventTableMarkLayout(events, [], null, { rows: [], complete: true }, [
      { at: now - 22 * minute, key: "monitor:st-1", name: "ci-box lines loud", detail: "Count 57 ≥ 50" },
    ]);
    expect(layout.rows.map((r) => r.type)).toEqual(["event", "monitor", "event"]);
  });

  test("a monitor opens as a hunt over a clock that holds its stretch", () => {
    expect(monitorHuntRange(now, { opened_at: now - 22 * minute, resolved_at: null })).toEqual({ range: "1h" });
    expect(monitorHuntRange(now, { opened_at: now - 8 * hour, resolved_at: null })).toEqual({ range: "24h" });
    expect(monitorHuntRange(now, { opened_at: now - 4 * 24 * hour, resolved_at: now - 3 * 24 * hour })).toEqual({ range: "7d" });
    const old = monitorHuntRange(now, { opened_at: now - 20 * 24 * hour, resolved_at: now - 20 * 24 * hour + hour });
    expect(old).toEqual({ range: "custom", fromMs: now - 20 * 24 * hour - 30 * minute, toMs: now - 20 * 24 * hour + hour + 30 * minute });
  });
});

describe("a monitor beside its hunt (#175, frame 18i)", () => {
  function rail(m: MonitorView): string {
    return renderToStaticMarkup(
      createElement(MonitorRail, { monitor: m, nowMs: now, onClose: () => {}, onEdit: () => {}, onPause: () => {}, onSilence: () => {} }),
    )
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
  }

  test("an open one: since when, what opens it, where its calls go", () => {
    const text = rail({
      ...quiet,
      open: stretch({ calls: [call(), call({ id: 2, what: "reminder", at: now - 7 * minute })] }),
    });
    expect(text).toContain("ci-box lines loud search");
    expect(text).toContain("open 22m since 10:41 · reminded 10:56");
    expect(text).toContain("opens when at least 1 in 15m");
    expect(text).toContain("calls ntfy.sh · remind every 15m");
    expect(text).toContain("Edit Pause Silence");
  });

  test("calls that do not go through are said; a paused one resumes", () => {
    expect(rail(monitor({ last_status: "503", consecutive_failures: 2 }))).toContain("failed 503 ×2");
    expect(rail(monitor())).not.toContain("failed");
    expect(rail(monitor({ enabled: 0 }))).toContain("Resume");
  });
});

const push = (over: Partial<MonitorView> = {}): MonitorView =>
  monitor({
    id: "m-push",
    name: "nightly-backup",
    kind: "threshold",
    source: "push",
    saved_search_id: null,
    saved: null,
    query: "monitor:nightly-backup",
    webhook_url: null,
    every_ms: 24 * hour,
    grace_ms: hour,
    due_from: now - 9 * hour,
    created_at: now - 30 * 24 * hour,
    started_at: null,
    last_ok_at: now - 9 * hour,
    paused_at: null,
    last_result: "ok",
    last_value: null,
    ...over,
  });

const result = (over: Partial<PushResultRow> = {}): PushResultRow => ({
  id: 1,
  monitor_id: "m-push",
  at: now - 4 * 24 * hour,
  status: "fail",
  exit_code: 1,
  duration_ms: 192_000,
  value: null,
  unit: null,
  message: "unable to create lock in backend",
  host: "10.0.4.12",
  via: "ping",
  ...over,
});

describe("push monitors on Watch (#177, frames 18c and 18f)", () => {
  test("a push lane says its schedule, and paused when it is", () => {
    expect(laneKind(push())).toBe("push · 1d · grace 1h");
    expect(laneKind(push({ every_ms: 7 * 24 * hour, grace_ms: 24 * hour }))).toBe("push · 7d · grace 1d");
    expect(laneKind(push({ enabled: 0, every_ms: 7 * 24 * hour }))).toBe("push · 7d · paused");
    expect(laneKind(push({ every_ms: null }))).toBe("push");
  });

  test("late past every, with when it goes down; the header counts it", () => {
    const zfs = push({ every_ms: hour, grace_ms: 15 * minute, due_from: now - 66 * minute });
    expect(pushReadout(zfs, now, null)).toMatchObject({ badge: "late 6m", tone: "amber", next: "down 11:12" });
    expect(watchCounts([zfs, errors], now)).toEqual({ open: 0, late: 1, warn: 0 });
  });

  test("open after a missed result says the due time it missed", () => {
    const open = stretch({ monitor_id: "m-push", opened_at: now - (7 * hour + 59 * minute), due_at: now - (8 * hour + 59 * minute) });
    const m = push({ state: "open", open, due_from: now - (32 * hour + 59 * minute) });
    expect(pushReadout(m, now, null)).toMatchObject({ badge: "open 7h 59m", tone: "red", next: "due 02:04 · missed" });
  });

  test("running from its /start, ok with when it is next due, paused since a day, warn amber", () => {
    expect(pushReadout(push({ started_at: now - 12 * minute }), now, null)).toMatchObject({ badge: "running 12m", next: "started 10:51" });
    expect(pushReadout(push(), now, null)).toMatchObject({ badge: "ok", tone: "sec", next: "next 10-21 02:03" });
    expect(pushReadout(push({ enabled: 0, paused_at: now - 12 * 24 * hour }), now, null)).toMatchObject({ badge: "paused", tone: "out", next: "since 10-08" });
    expect(pushReadout(push({ last_result: "warn", last_value: 87.2 }), now, null)).toMatchObject({ badge: "warn", tone: "amber", value: "87.2" });
  });

  test("each result a tick, a run a bar back to its /start", () => {
    const from = now - 7 * 24 * hour;
    const [tick] = pushTicks([result()], from, now);
    expect(tick!.tone).toBe("fail");
    expect(tick!.width).toBeCloseTo(192_000 / (7 * 24 * hour), 8);
    expect(pushTicks([result({ duration_ms: null })], from, now)[0]!.width).toBe(0);
    expect(pushTicks([result({ at: from - hour })], from, now)).toEqual([]);
  });

  test("a stretch is red, amber from the due time it missed; late is amber to now", () => {
    const from = now - 24 * hour;
    const s = stretch({ id: "st-m", monitor_id: "m-push", opened_at: now - 8 * hour, due_at: now - 9 * hour });
    const bands = pushBands(push({ state: "open", open: s }), [s], now, from, now);
    expect(bands.map((b) => b.kind)).toEqual(["late", "open"]);
    expect(pushDueLine(push({ state: "open", open: s }), now, from, now)).toBeCloseTo(15 / 24, 6);
    const late = push({ every_ms: hour, grace_ms: 15 * minute, due_from: now - 66 * minute });
    expect(pushBands(late, [], now, from, now).map((b) => b.kind)).toEqual(["late"]);
    expect(pushDueLine(push(), now, from, now)).toBeNull();
  });

  test("a result's card: its exit code, when, how long it ran and from where, and the stretch it opened", () => {
    const r = result();
    const s = stretch({ monitor_id: "m-push", opened_at: r.at, resolved_at: r.at + 24 * hour + 2 * minute, closed_by: "ok" });
    expect(resultCard(r, [s], now)).toMatchObject({
      badge: "fail · exit 1",
      tone: "red",
      at: "10-16 11:03:00",
      ran: "started 10:59:48 · ran 3m 12s · from 10.0.4.12",
      opened: "opened · resolved 10-17 11:05 · 24h 2m",
    });
  });

  test("its hunt opens on a clock that holds a few of its results", () => {
    expect(pushHuntRange({ every_ms: 24 * hour })).toBe("7d");
    expect(pushHuntRange({ every_ms: 5 * minute })).toBe("1h");
    expect(pushHuntRange({ every_ms: null })).toBe("24h");
  });

  test("the Push segment draws its lanes taller, says what a tick and a bar are, and when each is next due", () => {
    const data: MonitorsResponse = {
      now,
      from: new Date(now - 7 * 24 * hour).toISOString(),
      to: new Date(now).toISOString(),
      monitors: [push(), errors],
      stretches: [],
      sent: [],
      results: [result({ id: 2, status: "ok", at: now - 9 * hour })],
      dense: [],
      link: false,
    };
    const html = renderToStaticMarkup(
      createElement(WatchView, {
        data,
        canCreate: true,
        range: "7d",
        onRange: () => {},
        filter: "push",
        onFilter: () => {},
        marks: [],
        onNew: () => {},
        onOpen: () => {},
      }),
    );
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text).toContain("All 2 Search 1 Push 1");
    expect(text).toContain("Each tick is a result. A bar is a run, from its /start to its end. The dashed line is when the next one is due.");
    expect(text).toContain("nightly-backup push · 1d · grace 1h ok next 10-21 02:03");
    expect(text).not.toContain("api errors");
    expect(text).not.toContain("marks deploys and flags");
  });
});
