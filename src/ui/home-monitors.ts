import type { HomeCard } from "../control/home-since";
import type { ChangeMark } from "../shared/change-mark";
import { cardMoved } from "./home-saved";
import type { MonitorStretch, MonitorView, SavedSearch } from "./types";

/**
 * Monitors on Home (sheet 52): a saved hunt with a monitor is listed here, not in Moved or Quiet,
 * unless its reader chose Show in Moved. Each row says when it opened against the mark picked in
 * the Since bar: a time relation, never a cause.
 */

type TimedMark = Pick<ChangeMark, "ts" | "kind">;

/** A time against the mark. `away`: it started before the mark, so the mark did not start it. */
export type MonitorTiming = { text: string; away: boolean };

export type HomeMonitorRow = { monitor: MonitorView; card: HomeCard | undefined; timing: MonitorTiming | null };

export type HomeMonitors = {
  rows: HomeMonitorRow[];
  open: number;
  /** Open, moved, or opened and closed since the mark. */
  active: number;
  total: number;
  /** The line under the rows; null when every monitor is a row. */
  more: string | null;
};

/** The monitors listed at most before the rest fold into one line. */
export const homeMonitorRowsShown = 6;

/** "under 1 min", "3 min", "2 h", "2 h 5 min". */
export function gapText(ms: number): string {
  const minutes = Math.round(Math.abs(ms) / 60_000);
  if (minutes < 1) {
    return "under 1 min";
  }
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)} h ${rest} min` : `${Math.floor(minutes / 60)} h`;
}

/** The saved hunts Moved and Quiet read: those without a monitor, and those shown in Moved. */
export function readingHunts(hunts: readonly SavedSearch[], monitors: readonly MonitorView[]): SavedSearch[] {
  const watched = new Set(monitors.map((m) => m.saved?.id).filter(Boolean));
  return hunts.filter((h) => h.pinned || !watched.has(h.id));
}

/** True when this hunt has a monitor. */
export function huntHasMonitor(hunt: Pick<SavedSearch, "id">, monitors: readonly MonitorView[]): boolean {
  return monitors.some((m) => m.saved?.id === hunt.id);
}

/** True when this hunt is in Moved or Quiet only because its reader chose Show in Moved. */
export function shownInMoved(hunt: Pick<SavedSearch, "id" | "pinned">, monitors: readonly MonitorView[]): boolean {
  return Boolean(hunt.pinned) && huntHasMonitor(hunt, monitors);
}

/**
 * When a monitor opened, against the mark; null with no mark or nothing to say. A monitor that
 * opens on silence opens a whole window late, so it says when its last line came instead.
 */
export function monitorTiming(m: MonitorView, stretches: readonly MonitorStretch[], mark: TimedMark | null): MonitorTiming | null {
  if (!mark) {
    return null;
  }
  const markMs = Date.parse(mark.ts);
  if (m.open) {
    if (m.open.opened_at < markMs) {
      return { text: `before this ${mark.kind}`, away: true };
    }
    if (m.opens_when === "fewer_than" && typeof m.last_line_at === "number") {
      const after = m.last_line_at >= markMs;
      return { text: `last line ${gapText(m.last_line_at - markMs)} ${after ? "after" : "before"} ${mark.kind}`, away: !after };
    }
    return { text: `${gapText(m.open.opened_at - markMs)} after ${mark.kind}`, away: false };
  }
  // A stretch an edit or a pause closed says nothing about what the service did.
  const closed = stretches
    .filter((s) => s.monitor_id === m.id && s.opened_at >= markMs && s.resolved_at !== null && s.closed_by === "ok")
    .sort((a, b) => b.opened_at - a.opened_at)[0];
  if (!closed) {
    return null;
  }
  return { text: `opened ${gapText(closed.opened_at - markMs)} after · closed ${gapText(closed.resolved_at! - closed.opened_at)} later`, away: false };
}

/** A new fingerprint's first line against the mark; null with no mark or no time. */
export function firstSeenText(firstAt: string | null | undefined, mark: TimedMark | null): string | null {
  if (!mark || !firstAt) {
    return null;
  }
  return `first seen ${gapText(Date.parse(firstAt) - Date.parse(mark.ts))} after ${mark.kind}`;
}

/** Open first, newest open first; then those with a time; then those that only moved. */
function rank(row: HomeMonitorRow): number {
  return row.monitor.open ? 0 : row.timing ? 1 : 2;
}

/** The section's rows and counts. */
export function homeMonitors(
  monitors: readonly MonitorView[],
  cards: readonly HomeCard[],
  stretches: readonly MonitorStretch[],
  mark: TimedMark | null,
  shown = homeMonitorRowsShown,
): HomeMonitors {
  const byId = new Map(cards.map((c) => [c.saved_id, c]));
  const rows = monitors.map((monitor) => ({
    monitor,
    card: monitor.saved ? byId.get(monitor.saved.id) : undefined,
    timing: monitorTiming(monitor, stretches, mark),
  }));
  const active = rows
    .filter((r) => r.monitor.open || r.timing || cardMoved(r.card))
    .sort((a, b) => rank(a) - rank(b) || (b.monitor.open?.opened_at ?? 0) - (a.monitor.open?.opened_at ?? 0));
  const listed = active.slice(0, shown);
  const hidden = monitors.length - listed.length;
  const hiddenActive = active.length - listed.length;
  return {
    rows: listed,
    open: monitors.filter((m) => m.open).length,
    active: active.length,
    total: monitors.length,
    more: hidden === 0 ? null : hiddenActive > 0 ? `${hidden} more in Watch` : `${hidden} more, same as before`,
  };
}
