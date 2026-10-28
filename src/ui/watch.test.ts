import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { formatChangeMarkLabel, type ChangeMark } from "../shared/change-mark";
import { MonitorRail } from "./components/monitor-rail";
import { MarksLane, PlaceTags, WatchView } from "./components/watch-view";
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
  markHover,
  markPeek,
  markRowTime,
  markSpanLabel,
  marksHuntWindow,
  watchMarks,
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
  service: "ci",
  host: "ci-box",
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
    // 26g (#263): one row per monitor, state first, then what it is and its condition, checks, strip, last check, now.
    expect(text).toContain("Watch 3 monitors · 1 open · webhooks to ntfy.sh All 3 Search 2 Fingerprints 1 24h 7d 30d New monitor");
    expect(text).toContain("Monitor Checks Last 24h Last check Now");
    // Rows in order: the open one first.
    expect(text).toContain("ci-box lines loud ci ci-box open since 10:41 · 22m · search · host:ci-box · at least 1 line in 15m search · at least 1 · 15m 11:02 open 22m");
    expect(text.indexOf("ci-box lines loud")).toBeLessThan(text.indexOf("api errors"));
    expect(text).toContain("api errors api ok · last open");
    expect(text).toContain("search · at least 50 · 15m 11:02 12");
    expect(text).toContain("after a deploy api ok · fingerprints");
    expect(text).toContain("marks deploys and flags on the same clock");
    expect(text).toContain("2 marks");
    expect(text).toContain("What opened today 10:41 ● ci-box lines loud · still open sent ✓");
    expect(text).toContain("Delivery ntfy.sh · 3 monitors not called yet");
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
    service: "backup",
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
  result: "fail",
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
      results: [result({ id: 2, result: "ok", at: now - 9 * hour })],
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
    expect(text).toContain("nightly-backup backup push · 1d · grace 1h ok next 10-21 02:03");
    expect(text).not.toContain("api errors");
    expect(text).not.toContain("marks deploys and flags");
  });
});

describe("the marks row when deploys crowd (#212, frames 20b, 20c, 20f)", () => {
  // agental's day (20a): 43 deploys, a morning train of ten and an evening one of thirteen.
  const clock = ["00:30","01:10","02:40","03:50","04:30","05:20","06:10","07:21","07:27","07:40","07:52","08:05","08:13","08:30","08:41","08:55","09:02","10:15","11:00","11:45","12:30","13:20","14:05","15:10","16:00","16:50","17:40","18:25","19:05","19:40","20:09","20:14","20:20","20:41","20:58","21:12","21:30","21:36","21:42","21:55","22:05","22:14","22:20"];
  const hm = (c: string) => Number(c.slice(0, 2)) * 60 + Number(c.slice(3));
  // The day drawn ends at 22:31; here it ends at the tests' now.
  const day = clock.map((c, i) => mark(`d${i}`, now - (hm("22:31") - hm(c)) * minute, { title: `sha${i}` }));

  test("at 24h a train folds into a counted chip, the way Search's lane folds it (20b)", () => {
    const lane = watchMarks(day, dayAgo, now, "24h");
    expect(lane.count).toBe(43);
    expect(lane.washes).toBe(true);
    expect(lane.groups.filter((g) => g.members.length > 1).map((g) => g.members.length)).toEqual([10, 13]);
    expect(lane.groups.filter((g) => g.members.length === 1)).toHaveLength(20);
    // Nothing is named on a busy day: no lone mark has 12% of the clock to itself.
    expect(lane.groups.filter((g) => g.label)).toHaveLength(0);
    const train = lane.groups.find((g) => g.members.length === 10)!;
    expect(train.members[0]!.id).toBe("d16");
    expect(train.from).toBeLessThan(train.at);
    expect(train.at).toBeLessThan(train.to);
  });

  test("a lone mark keeps its name only with room, and the name stops short of the next mark", () => {
    const quiet = [
      mark("ci", now - 12 * hour, { service: "ci-runner", title: "v1.8.0" }),
      mark("api", now - 12 * hour + 19 * minute, { title: "v0.9.3" }),
      mark("flag", now - 5 * hour, { kind: "flag", service: "", title: "new-checkout on" }),
    ];
    const lane = watchMarks(quiet, dayAgo, now, "24h");
    expect(lane.groups.map((g) => g.members.length)).toEqual([2, 1]);
    const flag = lane.groups[1]!;
    expect(flag.label?.text).toBe(formatChangeMarkLabel(quiet[2]!));
    // Past 70% of the clock it is written to the left, kept to the room back to the chip.
    expect(flag.label?.end).toBe(true);
    expect(flag.label?.room).toBeCloseTo(flag.at - lane.groups[0]!.at, 6);
    expect(flag.label?.reservePx).toBe(38);
    // The two marks 18c drew far apart are both named.
    const apart = watchMarks([mark("v0.9.2", now - 19 * hour), mark("v0.9.3", now - 20 * minute)], dayAgo, now, "24h");
    expect(apart.groups.map((g) => g.label?.text)).toEqual(["api v0.9.2", "api v0.9.3"]);
    expect(apart.groups[0]!.label).toMatchObject({ end: false, reservePx: 18 });
  });

  test("past 24h a chip is a tick's worth of marks: a day at 7d, five days at 30d (20f)", () => {
    // Every 40 minutes for three days: a chain would fuse them all.
    const steady = Array.from({ length: 108 }, (_, i) => mark(`s${i}`, now - 3 * 24 * hour + i * 40 * minute));
    const week = watchMarks(steady, now - 7 * 24 * hour, now, "7d");
    expect(week.washes).toBe(false);
    expect(week.groups.length).toBe(4);
    for (const g of week.groups) {
      expect(new Date(g.fromMs).toISOString().slice(0, 10)).toBe(new Date(g.toMs).toISOString().slice(0, 10));
    }
    expect(week.groups.reduce((n, g) => n + g.members.length, 0)).toBe(108);

    const daily = Array.from({ length: 30 }, (_, i) => mark(`n${i}`, now - i * 24 * hour - hour));
    const month = watchMarks(daily, now - 30 * 24 * hour, now, "30d");
    const slots = new Set(daily.map((m) => Math.floor(Date.parse(m.ts) / (5 * 24 * hour))));
    expect(month.groups.length).toBe(slots.size);
    expect(month.washes).toBe(false);
  });

  test("a chip's peek, its list and the Search window it opens say what it holds (20c)", () => {
    const lane = watchMarks(day, dayAgo, now, "24h");
    const morning = lane.groups.find((g) => g.members.length === 10)!;
    expect(markPeek(morning, now)).toEqual({
      head: "10 marks · 10-19 19:53 – 21:34",
      names: ["api sha16", "api sha15"],
      more: "+8 more — click opens the list",
    });
    const evening = lane.groups.find((g) => g.members.length === 13)!;
    expect(markPeek(evening, now).head).toBe("13 marks · 08:41 – 10:52");
    expect(markSpanLabel(Date.parse("2026-10-19T23:50:00Z"), Date.parse("2026-10-20T00:10:00Z"), now)).toBe("10-19 23:50 – 00:10");
    expect(markSpanLabel(now - hour, now - hour, now)).toBe("10:03");
    expect(markRowTime(now - hour + 7_000, now)).toBe("10:03:07");
    expect(markRowTime(now - 24 * hour, now)).toBe("10-19 11:03");
    expect(markHover(mark("v0.9.3", now - 20 * minute), now)).toBe("api v0.9.3 · 10:43");
    expect(marksHuntWindow(now, now - 3 * hour, now - 2 * hour)).toEqual({ fromMs: now - 3 * hour - 30 * minute, toMs: now - 90 * minute });
    expect(marksHuntWindow(now, now - 20 * minute, now - 18 * minute)).toEqual({ fromMs: now - 35 * minute, toMs: now - 3 * minute });
  });

  test("Watch draws the chips and their washes, and no name at rest, on agental's day", () => {
    const data: MonitorsResponse = {
      now,
      from: new Date(dayAgo).toISOString(),
      to: new Date(now).toISOString(),
      monitors: [errors],
      stretches: [],
      sent: [],
      link: false,
    };
    const props = { data, canCreate: true, onRange: () => {}, filter: "all" as const, onFilter: () => {}, marks: day, onNew: () => {}, onOpen: () => {} };
    const html = renderToStaticMarkup(createElement(WatchView, { ...props, range: "24h" }));
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(html).toContain('aria-label="10 marks, 10-19 19:53 – 21:34"');
    expect(html).toContain('aria-label="13 marks, 08:41 – 10:52"');
    // 26g: the chips stay on the marks row; no wash runs through the monitor rows any more (#263).
    expect(html.match(/data-mark-wash=/g)).toBeNull();
    expect(html.match(/data-mark=/g)?.length).toBe(20);
    expect(text).toContain("43 marks");
    expect(text).not.toContain("sha");
    // At 7d there is no wash.
    const week = renderToStaticMarkup(createElement(WatchView, { ...props, range: "7d" }));
    expect(week).not.toContain("data-mark-wash=");
  });

  test("a hovered chip peeks, a pinned one lists its marks newest first with a way into Search (20c)", () => {
    const { groups } = watchMarks(day, dayAgo, now, "24h");
    const [morning, evening] = groups.filter((g) => g.members.length > 1);
    const html = renderToStaticMarkup(
      createElement(MarksLane, {
        groups,
        nowMs: now,
        hot: morning!.key,
        open: evening!.key,
        onHot: () => {},
        onOpenGroup: () => {},
        onOpenMarks: () => {},
      }),
    );
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text).toContain("10 marks · 10-19 19:53 – 21:34 api sha16 api sha15 +8 more — click opens the list");
    expect(text).toContain("13 marks 08:41 – 10:52 ×");
    expect(text.indexOf("api sha42")).toBeLessThan(text.indexOf("api sha30"));
    expect(text).toContain("Open 08:41 – 10:52 in Search ↗ Every service, this stretch, in a new tab.");
    expect(html).toContain('aria-expanded="true"');
    // The list ends at its chip, past 60% of the clock.
    expect(html).toContain("translateX(-100%)");
    // A lone triangle's hover names it.
    const lone = groups.find((g) => g.members.length === 1)!;
    const one = renderToStaticMarkup(
      createElement(MarksLane, { groups, nowMs: now, hot: lone.key, open: null, onHot: () => {}, onOpenGroup: () => {} }),
    );
    expect(one.replace(/<[^>]+>/g, " ")).toContain("api sha0 · 10-19 13:02");
  });
});

describe("Watch as a list (#263, 26g)", () => {
  test("a monitor without its own webhook is not a delivery host", async () => {
    const { deliveries } = await import("./watch");
    const rows = deliveries([
      { id: "a", name: "a", webhook_url: null, last_attempt_at: null, last_fired_at: null, last_error: null } as never,
      { id: "b", name: "b", webhook_url: "https://ntfy.sh/alerts", last_attempt_at: 5, last_fired_at: 5, last_error: null } as never,
    ]);
    expect(rows).toEqual([{ host: "ntfy.sh", ok: true, lastAt: 5, monitors: 1 }]);
  });
});

describe("a monitor's service and host on Watch (#335, frame 33g)", () => {
  const tags = (m: { service: string; host: string }) =>
    renderToStaticMarkup(createElement(PlaceTags, { monitor: m })).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  test("its service and the host it checks, under its name", () => {
    expect(tags({ service: "api", host: "api.example.com" })).toBe("api api.example.com");
    expect(tags({ service: "api", host: "" })).toBe("api");
  });
});
