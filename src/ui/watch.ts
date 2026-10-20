import { seriesLabel } from "../query/agg";
import { parseRangeMs } from "../query/relative";
import { formatChangeMarkLabel, type ChangeMark } from "../shared/change-mark";
import { formatOpenFor, type MonitorSource } from "../shared/monitor";
import { formatSpan, isLate, isRunning, pushDueAt, pushOpensAt, type PushClock } from "../shared/push";
import { formatCompactCount } from "./count-format";
import { formatAggStat } from "./fill-histogram";
import type { MonitorCall, MonitorStretch, MonitorView, PushResultRow } from "./types";

/**
 * Watch (#175, frame 18c): every monitor a lane on one clock, open ones first. The clock is
 * 24h, 7d or 30d back from now.
 */
export const watchRanges = ["24h", "7d", "30d"] as const;
export type WatchRange = (typeof watchRanges)[number];

const hourMs = 60 * 60_000;
const dayMs = 24 * hourMs;

export function watchRangeMs(range: WatchRange): number {
  return range === "24h" ? dayMs : range === "7d" ? 7 * dayMs : 30 * dayMs;
}

export type WatchFilter = "all" | MonitorSource;

/** The segments over the lanes: All, then each source a monitor has, in 18c's order. */
export function watchFilters(monitors: readonly MonitorView[]): Array<{ id: WatchFilter; label: string; n: number }> {
  const order: Array<[MonitorSource, string]> = [
    ["search", "Search"],
    ["push", "Push"],
    ["fingerprints", "Fingerprints"],
  ];
  const out: Array<{ id: WatchFilter; label: string; n: number }> = [{ id: "all", label: "All", n: monitors.length }];
  for (const [id, label] of order) {
    const n = monitors.filter((m) => sourceOf(m) === id).length;
    if (n > 0) {
      out.push({ id, label, n });
    }
  }
  return out;
}

export function sourceOf(m: Pick<MonitorView, "source" | "kind">): MonitorSource {
  return m.source ?? (m.kind === "first_seen" ? "fingerprints" : "search");
}

/** Open ones first, the one opened last on top; then the rest as they were made, newest first. */
export function sortForWatch(monitors: readonly MonitorView[]): MonitorView[] {
  const open = monitors
    .filter((m) => m.state === "open")
    .sort((a, b) => (b.open?.opened_at ?? 0) - (a.open?.opened_at ?? 0));
  return [...open, ...monitors.filter((m) => m.state !== "open")];
}

/** The header's tell (18c): how many are open, how many push monitors are late, and how many last said warn. */
export function watchCounts(
  monitors: readonly MonitorView[],
  nowMs = Date.now(),
): { open: number; late: number; warn: number } {
  return {
    open: monitors.filter((m) => m.state === "open").length,
    late: monitors.filter((m) => sourceOf(m) === "push" && isLate(pushClock(m), nowMs)).length,
    warn: monitors.filter((m) => m.state !== "open" && m.last_result === "warn").length,
  };
}

/** A push monitor's clock, as the server keeps it (#177). */
export function pushClock(m: MonitorView): PushClock {
  return {
    enabled: m.enabled ?? 1,
    state: m.state ?? "ok",
    every_ms: m.every_ms ?? null,
    grace_ms: m.grace_ms ?? null,
    due_from: m.due_from ?? null,
    created_at: m.created_at ?? 0,
    started_at: m.started_at ?? null,
  };
}

function plain(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString("en-US") : String(Number(n.toPrecision(6)));
}

/** "at least 50", "p99(duration_ms) at least 800": what opens a search monitor. */
export function opensWhen(m: Pick<MonitorView, "threshold" | "saved">): string {
  const agg = m.saved?.agg ?? null;
  return `${agg ? `${seriesLabel(agg)} ` : ""}at least ${plain(m.threshold)}`;
}

/** Under a lane's name: "search · at least 50 · 15m", "fingerprints · 24h", "push · 1d · grace 1h". */
export function laneKind(m: MonitorView): string {
  if (sourceOf(m) === "fingerprints") {
    return "fingerprints · 24h";
  }
  if (sourceOf(m) === "push") {
    const every = m.every_ms ?? null;
    if (every === null) {
      return m.enabled === 0 ? "push · paused" : "push";
    }
    if (m.enabled === 0) {
      return `push · ${formatSpan(every)} · paused`;
    }
    return `push · ${formatSpan(every)} · grace ${formatSpan(m.grace_ms ?? Math.min(every, 60 * 60_000))}`;
  }
  return `search · ${opensWhen(m)} · ${m.saved?.range ?? "custom"}`;
}

/** An open card's second line: "search · host:ci-box · at least 50 lines in 15m". */
export function openCardLine(m: MonitorView): string {
  const q = m.saved?.query.trim() || "*";
  if (sourceOf(m) === "fingerprints") {
    return `fingerprints · ${q} · after a deploy or flag`;
  }
  if (sourceOf(m) === "push") {
    return pushCardLine(m, Date.now());
  }
  const agg = m.saved?.agg ?? null;
  const what = agg ? opensWhen(m) : `at least ${plain(m.threshold)} line${m.threshold === 1 ? "" : "s"}`;
  return `search · ${q} · ${what} in ${m.saved?.range ?? "its window"}`;
}

export type LaneReadout = { badge: string; tone: "red" | "amber" | "sec" | "out"; text: string };

/** Right of a lane: its state, and what it last read. */
export function laneReadout(m: MonitorView, nowMs: number, sentInWindow: number): LaneReadout {
  if (sourceOf(m) === "push") {
    const r = pushReadout(m, nowMs, null);
    // On 18c's one line a push lane says its state, and its value when it has one.
    return { badge: r.badge, tone: r.tone, text: r.value };
  }
  if (m.enabled === 0) {
    return { badge: "paused", tone: "sec", text: "" };
  }
  const silenced = typeof m.silenced_until === "number" && m.silenced_until > nowMs ? "silenced" : "";
  if (m.state === "open" && m.open) {
    return { badge: `open ${formatOpenFor(nowMs - m.open.opened_at)}`, tone: "red", text: silenced };
  }
  let reading = "";
  if (sourceOf(m) === "fingerprints") {
    reading = `${sentInWindow} sent`;
  } else if (m.last_status === "refused" || m.last_status === "error") {
    reading = m.last_status;
  } else if (typeof m.last_value === "number") {
    reading = m.saved?.agg ? formatAggStat(m.last_value) : formatCompactCount(m.last_value);
  }
  return { badge: "ok", tone: "sec", text: [reading, silenced].filter(Boolean).join(" · ") };
}

/** Where a time falls on the clock, 0 to 1. */
export function clockFrac(ms: number, fromMs: number, toMs: number): number {
  return toMs > fromMs ? (ms - fromMs) / (toMs - fromMs) : 0;
}

/** Smallest a stretch is drawn, as a share of the lane, so a short one still shows. */
export const minStretchFrac = 0.006;

export type StretchSpan = { id: string; left: number; width: number; open: boolean; stretch: MonitorStretch };

/** A monitor's stretches as spans of its lane: dim when resolved, red to now while open. */
export function stretchSpans(
  stretches: readonly MonitorStretch[],
  fromMs: number,
  toMs: number,
  nowMs: number,
): StretchSpan[] {
  const out: StretchSpan[] = [];
  for (const s of stretches) {
    const end = s.resolved_at ?? nowMs;
    if (end < fromMs || s.opened_at > toMs) {
      continue;
    }
    let left = Math.max(0, clockFrac(s.opened_at, fromMs, toMs));
    const right = Math.min(1, clockFrac(end, fromMs, toMs));
    let width = Math.max(minStretchFrac, right - left);
    if (left + width > 1) {
      left = Math.max(0, 1 - width);
      width = Math.min(width, 1);
    }
    out.push({ id: s.id, left, width, open: s.resolved_at === null, stretch: s });
  }
  return out;
}

/** Each new-fingerprints call a dot on its lane. */
export function sentDots(calls: readonly MonitorCall[], fromMs: number, toMs: number): Array<{ id: number; left: number }> {
  return calls
    .filter((c) => c.at >= fromMs && c.at <= toMs)
    .map((c) => ({ id: c.id, left: clockFrac(c.at, fromMs, toMs) }));
}

const pad = (n: number) => String(n).padStart(2, "0");

function mmdd(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** "now 11:03", or "now 10-20 11:03" on a clock longer than a day (18f). */
export function nowLabel(nowMs: number, range: WatchRange): string {
  return range === "24h" ? `now ${hhmm(nowMs)}` : `now ${mmdd(nowMs)} ${hhmm(nowMs)}`;
}

/**
 * The clock's ticks, in UTC: every 3h over 24h (a midnight says its date, 18c), every day over
 * 7d, every 5 days over 30d.
 */
export function watchTicks(fromMs: number, toMs: number, range: WatchRange): Array<{ left: number; label: string }> {
  const step = range === "24h" ? 3 * hourMs : range === "7d" ? dayMs : 5 * dayMs;
  const out: Array<{ left: number; label: string }> = [];
  let t = Math.ceil(fromMs / step) * step;
  for (; t < toMs; t += step) {
    const left = clockFrac(t, fromMs, toMs);
    // Too near either end, a label would run off the lane.
    if (left < 0.02 || left > 0.97) {
      continue;
    }
    const midnight = t % dayMs === 0;
    out.push({ left, label: range === "24h" && !midnight ? hhmm(t) : mmdd(t) });
  }
  return out;
}

/** Deploy and flag marks on the clock's last row, and the words beside them where there is room. */
export function watchMarks(
  marks: readonly ChangeMark[],
  fromMs: number,
  toMs: number,
): { glyphs: Array<{ id: string; kind: ChangeMark["kind"]; left: number }>; labels: Array<{ left: number; text: string; end: boolean }>; count: number } {
  const shown = marks
    .filter((m) => m.kind === "deploy" || m.kind === "flag")
    .map((m) => ({ mark: m, left: clockFrac(Date.parse(m.ts), fromMs, toMs) }))
    .filter((m) => m.left >= 0 && m.left <= 1)
    .sort((a, b) => a.left - b.left);
  // Marks closer than 3% of the clock share one label.
  const groups: Array<{ left: number; right: number; texts: string[] }> = [];
  for (const m of shown) {
    const last = groups.at(-1);
    const text = m.mark.kind === "deploy" ? `${m.mark.service} ${m.mark.title}`.trim() : formatChangeMarkLabel(m.mark);
    if (last && m.left - last.right < 0.03) {
      last.right = m.left;
      last.texts.push(text);
    } else {
      groups.push({ left: m.left, right: m.left, texts: [text] });
    }
  }
  const labels: Array<{ left: number; text: string; end: boolean }> = [];
  let freeFrom = 0;
  for (const g of groups) {
    const text = g.texts.join(" · ");
    const end = g.left > 0.7;
    // About 0.6% of the clock a character, at 1280.
    const width = text.length * 0.006;
    const start = end ? g.right - width : g.left;
    if (start < freeFrom) {
      continue;
    }
    labels.push({ left: end ? g.right : g.left, text, end });
    freeFrom = (end ? g.right : g.left + width) + 0.02;
  }
  return {
    glyphs: shown.map((m) => ({ id: m.mark.id, kind: m.mark.kind, left: m.left })),
    labels,
    count: shown.length,
  };
}

/** "10:41", or "10-19 10:41" when it was not today. */
export function clockAt(ms: number, nowMs: number): string {
  return mmdd(ms) === mmdd(nowMs) ? hhmm(ms) : `${mmdd(ms)} ${hhmm(ms)}`;
}

/** "ntfy.sh": where its calls go. */
export function callHost(url: string | null): string {
  if (!url) {
    return "—";
  }
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** "ntfy" for ntfy.sh, "slack" for hooks.slack.com; an address or a bare name as it is. */
export function serviceName(host: string): string {
  const name = host.replace(/:\d+$/, "");
  if (/^[\d.]+$/.test(name) || name.includes(":") || !name.includes(".")) {
    return host;
  }
  const labels = name.split(".");
  return labels[labels.length - 2]!;
}

/** "10:41 open · ntfy 200": a call as a stretch lists it (18o). */
export function callLine(call: MonitorCall, host: string, nowMs: number): string {
  const how = call.status === "silenced" ? "silenced" : `${serviceName(host)} ${call.status}`;
  return `${clockAt(call.at, nowMs)} ${call.what} · ${how}`;
}

/** "14:41 reminder, if still open": the next call an open stretch will make, when it reminds. */
export function nextReminder(m: MonitorView, nowMs: number): number | null {
  const s = m.open;
  if (!s || m.state !== "open" || m.enabled === 0) {
    return null;
  }
  const remind = m.remind_every ?? "window";
  if (remind === "off") {
    return null;
  }
  const windowMs = (m.saved?.range ? parseRangeMs(m.saved.range) : null) ?? 5 * 60_000;
  const every = remind === "window" ? windowMs : remind === "1h" ? hourMs : remind === "4h" ? 4 * hourMs : dayMs;
  const at = (s.called_at ?? s.opened_at) + every;
  return at > nowMs ? at : nowMs;
}

/** "remind 4h", "remind every 15m", "no reminders". */
export function remindLabel(m: Pick<MonitorView, "remind_every" | "saved">): string {
  const r = m.remind_every ?? "window";
  if (r === "off") {
    return "no reminders";
  }
  if (r === "window") {
    return `remind every ${m.saved?.range ?? "5m"}`;
  }
  return `remind ${r}`;
}

/** The deploy or flag a stretch opened after (18o's "before it"). */
export function markBefore(
  marks: readonly ChangeMark[],
  before: ChangeMark | null,
  atMs: number,
): ChangeMark | null {
  const all = before ? [before, ...marks] : [...marks];
  let best: ChangeMark | null = null;
  for (const m of all) {
    if ((m.kind !== "deploy" && m.kind !== "flag") || Date.parse(m.ts) > atMs) {
      continue;
    }
    if (!best || Date.parse(m.ts) > Date.parse(best.ts)) {
      best = m;
    }
  }
  return best;
}

/** Quick ranges a monitor's hunt can open on, smallest first. */
const huntRanges = [
  ["1h", hourMs],
  ["4h", 4 * hourMs],
  ["24h", dayMs],
  ["7d", 7 * dayMs],
] as const;

/**
 * The clock a monitor opens on as a hunt (18i, 18o): the smallest Quick range that holds its
 * stretch with room before it, or a window around a stretch older than that.
 */
export function monitorHuntRange(
  nowMs: number,
  stretch: Pick<MonitorStretch, "opened_at" | "resolved_at">,
): { range: "1h" | "4h" | "24h" | "7d" } | { range: "custom"; fromMs: number; toMs: number } {
  for (const [range, ms] of huntRanges) {
    if (nowMs - stretch.opened_at <= 0.75 * ms) {
      return { range };
    }
  }
  const end = stretch.resolved_at ?? nowMs;
  const pad = Math.max(15 * 60_000, (end - stretch.opened_at) / 2);
  return { range: "custom", fromMs: stretch.opened_at - pad, toMs: Math.min(nowMs, end + pad) };
}

/** "87.2 %", "3": a pushed value with its unit. */
export function pushValue(value: number | null | undefined, unit: string | null | undefined): string {
  if (typeof value !== "number") {
    return "";
  }
  const n = Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)));
  return unit ? `${n} ${unit}` : n;
}

/** "10-08", or "14:02" today. */
function dayAt(ms: number, nowMs: number): string {
  return mmdd(ms) === mmdd(nowMs) ? hhmm(ms) : mmdd(ms);
}

export type PushReadout = LaneReadout & {
  /** 18f's second line: when it is next due, when it opens, when its run started. */
  next: string;
  /** Its last value, for 18c's one line. */
  value: string;
};

/**
 * Right of a push lane (18f): open, late, running, warn or ok, and under it when the next result
 * is due, when a late one opens ("down"), or the due time it missed.
 */
export function pushReadout(m: MonitorView, nowMs: number, open: MonitorStretch | null): PushReadout {
  const clock = pushClock(m);
  const value = pushValue(m.last_value, null);
  if (m.enabled === 0) {
    return { badge: "paused", tone: "out", text: "", next: m.paused_at ? `since ${dayAt(m.paused_at, nowMs)}` : "", value: "" };
  }
  const due = pushDueAt(clock);
  const stretch = open ?? m.open;
  if (m.state === "open" && stretch) {
    const badge = `open ${formatOpenFor(nowMs - stretch.opened_at)}`;
    if (stretch.due_at != null) {
      return { badge, tone: "red", text: "", next: `due ${clockAt(stretch.due_at, nowMs)} · missed`, value };
    }
    return { badge, tone: "red", text: "", next: due !== null && due > nowMs ? `next ${clockAt(due, nowMs)}` : "", value };
  }
  if (isLate(clock, nowMs)) {
    const opens = pushOpensAt(clock)!;
    return { badge: `late ${formatOpenFor(nowMs - due!)}`, tone: "amber", text: "", next: `down ${clockAt(opens, nowMs)}`, value };
  }
  if (isRunning(clock)) {
    return {
      badge: `running ${formatOpenFor(nowMs - clock.started_at!)}`,
      tone: "sec",
      text: "",
      next: `started ${clockAt(clock.started_at!, nowMs)}`,
      value,
    };
  }
  const next =
    due !== null
      ? `next ${clockAt(due, nowMs)}`
      : m.last_result_at
        ? `last ${clockAt(m.last_result_at, nowMs)}`
        : "";
  return m.last_result === "warn"
    ? { badge: "warn", tone: "amber", text: "", next, value }
    : { badge: "ok", tone: "sec", text: "", next, value };
}

/** An open push card's second line (18c): "push · every 1d, grace 1h · last result 10-19 02:04 ok". */
export function pushCardLine(m: MonitorView, nowMs: number): string {
  const every = m.every_ms ?? null;
  const schedule =
    every === null ? "by its results" : `every ${formatSpan(every)}, grace ${formatSpan(m.grace_ms ?? Math.min(every, 60 * 60_000))}`;
  const last = m.last_result_at ? ` · last result ${clockAt(m.last_result_at, nowMs)} ${m.last_result ?? ""}`.trimEnd() : "";
  return `push · ${schedule}${last}`;
}

export type PushTick = {
  id: number;
  left: number;
  /** A run's bar, from its /start to its end; 0 draws a 2px tick. */
  width: number;
  tone: "ok" | "warn" | "fail";
  result: PushResultRow;
};

/** Each result a tick, each run a bar back to its /start (18f). */
export function pushTicks(results: readonly PushResultRow[], fromMs: number, toMs: number): PushTick[] {
  const out: PushTick[] = [];
  for (const r of results) {
    const end = clockFrac(r.at, fromMs, toMs);
    if (end < 0 || end > 1) {
      continue;
    }
    const start = r.duration_ms ? Math.max(0, clockFrac(r.at - r.duration_ms, fromMs, toMs)) : end;
    out.push({ id: r.id, left: start, width: end - start, tone: r.result, result: r });
  }
  return out;
}

export type PushBand = { key: string; left: number; width: number; kind: "late" | "open" | "resolved" | "running"; stretch: MonitorStretch | null };

function span(fromT: number, toT: number, fromMs: number, toMs: number): { left: number; width: number } | null {
  if (toT < fromMs || fromT > toMs) {
    return null;
  }
  const left = Math.max(0, clockFrac(fromT, fromMs, toMs));
  const right = Math.min(1, clockFrac(toT, fromMs, toMs));
  return { left, width: Math.max(minStretchFrac / 2, right - left) };
}

/**
 * A push lane's bands (18f): each stretch red (dim once resolved), amber before it from the due
 * time it missed, amber from the due time to now while late, and an outline while a run is going.
 */
export function pushBands(
  m: MonitorView,
  stretches: readonly MonitorStretch[],
  nowMs: number,
  fromMs: number,
  toMs: number,
): PushBand[] {
  const out: PushBand[] = [];
  for (const s of stretches) {
    if (s.due_at != null && s.due_at < s.opened_at) {
      const late = span(s.due_at, s.opened_at, fromMs, toMs);
      if (late) {
        out.push({ key: `${s.id}-late`, ...late, kind: "late", stretch: s });
      }
    }
    const open = span(s.opened_at, s.resolved_at ?? nowMs, fromMs, toMs);
    if (open) {
      out.push({ key: s.id, ...open, kind: s.resolved_at === null ? "open" : "resolved", stretch: s });
    }
  }
  const clock = pushClock(m);
  if (isLate(clock, nowMs)) {
    const late = span(pushDueAt(clock)!, nowMs, fromMs, toMs);
    if (late) {
      out.push({ key: "late-now", ...late, kind: "late", stretch: null });
    }
  }
  if (isRunning(clock) && m.state !== "open") {
    const run = span(clock.started_at!, nowMs, fromMs, toMs);
    if (run) {
      out.push({ key: "running", ...run, kind: "running", stretch: null });
    }
  }
  return out;
}

/** The dashed line (18f): when the result it waits for was due, while that is on the clock. */
export function pushDueLine(m: MonitorView, nowMs: number, fromMs: number, toMs: number): number | null {
  const missed = m.state === "open" ? (m.open?.due_at ?? null) : null;
  const clock = pushClock(m);
  const due = missed ?? (isLate(clock, nowMs) ? pushDueAt(clock) : null);
  if (due === null) {
    return null;
  }
  const at = clockFrac(due, fromMs, toMs);
  return at >= 0 && at <= 1 ? at : null;
}

/** "3m 12s", "45s", "1h 4m": how long a run took. */
export function formatRun(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  if (s < 3600) {
    const rest = s % 60;
    return rest > 0 ? `${Math.floor(s / 60)}m ${rest}s` : `${Math.floor(s / 60)}m`;
  }
  return formatOpenFor(ms);
}

function hhmmss(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** A result's card on a push lane (18f): what it said, when, how long it ran and from where. */
export function resultCard(
  r: PushResultRow,
  stretches: readonly MonitorStretch[],
  nowMs: number,
): { badge: string; tone: LaneReadout["tone"]; at: string; ran: string; message: string; stretch: MonitorStretch | null; opened: string } {
  const badge = r.exit_code !== null ? `${r.result} · exit ${r.exit_code}` : r.result;
  const tone = r.result === "fail" ? "red" : r.result === "warn" ? "amber" : "sec";
  const ran = [
    r.duration_ms ? `started ${hhmmss(r.at - r.duration_ms)}` : "",
    r.duration_ms ? `ran ${formatRun(r.duration_ms)}` : "",
    r.host ? `from ${r.host}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  // The stretch this result opened: it opened in the same second the result arrived.
  const stretch = stretches.find((s) => Math.abs(s.opened_at - r.at) < 1000) ?? null;
  const opened = stretch
    ? stretch.resolved_at !== null
      ? `opened · resolved ${clockAt(stretch.resolved_at, nowMs)} · ${formatOpenFor(stretch.resolved_at - stretch.opened_at)}`
      : `opened · open ${formatOpenFor(nowMs - stretch.opened_at)}`
    : "";
  return { badge, tone, at: `${mmdd(r.at)} ${hhmmss(r.at)}`, ran, message: r.message, stretch, opened };
}

/** The clock a push monitor opens on as a hunt with nothing open (18i): a few of its results. */
export function pushHuntRange(m: Pick<MonitorView, "every_ms">): "1h" | "4h" | "24h" | "7d" {
  const every = m.every_ms ?? null;
  if (every === null) {
    return "24h";
  }
  const want = every * 6;
  return want <= hourMs ? "1h" : want <= 4 * hourMs ? "4h" : want <= dayMs ? "24h" : "7d";
}
