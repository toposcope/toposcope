import { seriesLabel } from "../query/agg";
import { parseRangeMs } from "../query/relative";
import { formatChangeMarkLabel, type ChangeMark } from "../shared/change-mark";
import { formatCertShort, parseConditions } from "../shared/http-check";
import { formatOpenFor, laneColumns, type MonitorSource } from "../shared/monitor";
import { formatCompactCount } from "./count-format";
import { formatAggStat } from "./fill-histogram";
import type { MonitorCall, MonitorResultRow, MonitorStretch, MonitorView } from "./types";

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
    ["http", "HTTP"],
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

/** The header's tell (18c): how many are open, and how many last said warn. */
export function watchCounts(monitors: readonly MonitorView[]): { open: number; warn: number } {
  return {
    open: monitors.filter((m) => m.state === "open").length,
    warn: monitors.filter((m) => m.state !== "open" && m.last_result === "warn").length,
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

/** An HTTP(S) monitor's lines, read. */
function httpLines(m: MonitorView) {
  const read = parseConditions(m.http?.conditions ?? "");
  return "error" in read ? [] : read;
}

/** An HTTP(S) monitor whose only line is `cert > …`: it reads days left, not time (18c). */
function certOnly(m: MonitorView): boolean {
  const lines = httpLines(m);
  return lines.length === 1 && lines[0]!.cond.what === "cert";
}

/** "3 conditions", "cert > 14d", "any 2xx". */
export function httpConditionsLabel(m: MonitorView): string {
  const lines = httpLines(m);
  if (lines.length === 0) {
    return "any 2xx";
  }
  if (lines.length === 1) {
    return lines[0]!.text;
  }
  return `${lines.length} conditions`;
}

/** Under a lane's name: "search · at least 50 · 15m", "fingerprints · 24h", "http · 30s · 3 conditions". */
export function laneKind(m: MonitorView): string {
  if (sourceOf(m) === "fingerprints") {
    return "fingerprints · 24h";
  }
  if (sourceOf(m) === "http") {
    return `http · ${m.http?.every ?? "30s"} · ${httpConditionsLabel(m)}`;
  }
  return `search · ${opensWhen(m)} · ${m.saved?.range ?? "custom"}`;
}

/** An open card's second line: "search · host:ci-box · at least 50 lines in 15m". */
export function openCardLine(m: MonitorView): string {
  if (sourceOf(m) === "http") {
    const why = m.http?.last_run?.why ?? m.open?.open_message ?? "";
    return `http · ${m.http?.method ?? "GET"} ${m.http?.url ?? ""}${why ? ` · ${why}` : ""}`;
  }
  const q = m.saved?.query.trim() || "*";
  if (sourceOf(m) === "fingerprints") {
    return `fingerprints · ${q} · after a deploy or flag`;
  }
  const agg = m.saved?.agg ?? null;
  const what = agg ? opensWhen(m) : `at least ${plain(m.threshold)} line${m.threshold === 1 ? "" : "s"}`;
  return `search · ${q} · ${what} in ${m.saved?.range ?? "its window"}`;
}

/** Red is open; amber a warn, or an HTTP(S) run that failed before it opens (18c). */
export type LaneReadout = { badge: string; tone: "red" | "amber" | "sec"; text: string };

/** Right of a lane: its state, and what it last read. */
export function laneReadout(m: MonitorView, nowMs: number, sentInWindow: number): LaneReadout {
  if (m.enabled === 0) {
    return { badge: "paused", tone: "sec", text: "" };
  }
  const silenced = typeof m.silenced_until === "number" && m.silenced_until > nowMs ? "silenced" : "";
  if (m.state === "open" && m.open) {
    return { badge: `open ${formatOpenFor(nowMs - m.open.opened_at)}`, tone: "red", text: silenced };
  }
  let reading = "";
  if (sourceOf(m) === "http") {
    const run = m.http?.last_run;
    const left = run?.cert_valid_to ? Date.parse(run.cert_valid_to) - nowMs : null;
    if (run && certOnly(m)) {
      reading = left !== null ? `${formatCertShort(left)} left` : run.why ?? "";
    } else if (run) {
      reading = run.status === null ? "no response" : `${run.duration_ms}ms`;
    }
    const badge = run?.result === "warn" ? "warn" : run?.result === "fail" ? "fail" : "ok";
    return { badge, tone: badge === "ok" ? "sec" : "amber", text: [reading, silenced].filter(Boolean).join(" · ") };
  }
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

export type HttpTick = { id: number; left: number; width: number; tone: "ok" | "warn" | "fail"; result: MonitorResultRow };

/**
 * An HTTP(S) lane (18c). Runs closer together than a column (every 30s over 24h) read as a
 * texture, with each column that warned or failed drawn on it; sparser runs (every 1h) are each
 * a tick. The results are already the worst of each column.
 */
export function httpLane(
  results: readonly MonitorResultRow[],
  everyMs: number,
  fromMs: number,
  toMs: number,
): { dense: boolean; ticks: HttpTick[] } {
  const column = 1 / laneColumns;
  const dense = everyMs < (toMs - fromMs) * column;
  const ticks: HttpTick[] = [];
  for (const r of results) {
    const at = clockFrac(r.at, fromMs, toMs);
    if (at < 0 || at > 1 || (dense && r.result === "ok")) {
      continue;
    }
    ticks.push(
      dense
        ? { id: r.id, left: Math.min(laneColumns - 1, Math.floor(at * laneColumns)) * column, width: column, tone: r.result, result: r }
        : { id: r.id, left: at, width: 0, tone: r.result, result: r },
    );
  }
  return { dense, ticks };
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
  const windowMs = m.http?.every_ms ?? (m.saved?.range ? parseRangeMs(m.saved.range) : null) ?? 5 * 60_000;
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
