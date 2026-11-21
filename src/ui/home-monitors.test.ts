import { describe, expect, test } from "bun:test";
import type { HomeCard } from "../control/home-since";
import { firstSeenText, gapText, homeMonitors, monitorTiming, readingHunts, shownInMoved } from "./home-monitors";
import type { MonitorStretch, MonitorView, SavedSearch } from "./types";

const markMs = Date.parse("2026-11-21T15:59:00.000Z");
const mark = { ts: new Date(markMs).toISOString(), kind: "deploy" as const };
const min = 60_000;

const stretch = (monitor_id: string, opened: number, closed: number | null, closed_by: MonitorStretch["closed_by"] = "ok") =>
  ({ id: `${monitor_id}-${opened}`, monitor_id, opened_at: markMs + opened * min, resolved_at: closed === null ? null : markMs + closed * min, closed_by }) as MonitorStretch;

const monitor = (id: string, over: Partial<MonitorView> = {}) => ({ id, name: id, saved: { id: `h-${id}`, name: id, query: "x", range: "1h", agg: null }, open: null, ...over }) as MonitorView;

const card = (id: string, before: number, after: number) => ({ saved_id: `h-${id}`, before, after, refused: null }) as HomeCard;

describe("a gap", () => {
  test("reads in minutes, then hours", () => {
    expect(gapText(20_000)).toBe("under 1 min");
    expect(gapText(3 * min)).toBe("3 min");
    expect(gapText(120 * min)).toBe("2 h");
    expect(gapText(125 * min)).toBe("2 h 5 min");
  });
});

describe("when a monitor opened, against the mark", () => {
  test("no mark, nothing to say", () => {
    expect(monitorTiming(monitor("a", { open: stretch("a", 3, null) }), [], null)).toBeNull();
  });

  test("open after the mark", () => {
    expect(monitorTiming(monitor("a", { open: stretch("a", 3, null) }), [], mark)).toEqual({ text: "3 min after deploy", away: false });
  });

  test("open before the mark points away from it", () => {
    expect(monitorTiming(monitor("a", { open: stretch("a", -120, null) }), [], mark)).toEqual({ text: "before this deploy", away: true });
  });

  test("a monitor that opens on silence says when its last line came", () => {
    const silent = { open: stretch("a", 34, null), opens_when: "fewer_than" as const };
    expect(monitorTiming(monitor("a", { ...silent, last_line_at: markMs + 4 * min }), [], mark)).toEqual({ text: "last line 4 min after deploy", away: false });
    expect(monitorTiming(monitor("a", { ...silent, last_line_at: markMs - 9 * min }), [], mark)).toEqual({ text: "last line 9 min before deploy", away: true });
  });

  test("opened and closed since the mark; the newest one", () => {
    const list = [stretch("a", 2, 3), stretch("a", 8, 13), stretch("b", 20, 21)];
    expect(monitorTiming(monitor("a"), list, mark)).toEqual({ text: "opened 8 min after · closed 5 min later", away: false });
  });

  test("a stretch closed by an edit, or before the mark, says nothing", () => {
    expect(monitorTiming(monitor("a"), [stretch("a", 8, 13, "edit"), stretch("a", -30, -20)], mark)).toBeNull();
  });

  test("a new fingerprint's first line", () => {
    expect(firstSeenText(new Date(markMs + 2 * min).toISOString(), mark)).toBe("first seen 2 min after deploy");
    expect(firstSeenText(undefined, mark)).toBeNull();
    expect(firstSeenText(new Date(markMs).toISOString(), null)).toBeNull();
  });
});

describe("Moved and Quiet read", () => {
  test("hunts without a monitor, and those shown in Moved", () => {
    const hunts = [{ id: "h-a" }, { id: "h-b", pinned: true }, { id: "h-c" }] as SavedSearch[];
    expect(readingHunts(hunts, [monitor("a"), monitor("b")]).map((h) => h.id)).toEqual(["h-b", "h-c"]);
  });
});

describe("a hunt shown in Moved", () => {
  test("is a pinned hunt with a monitor", () => {
    const list = [monitor("a")];
    expect(shownInMoved({ id: "h-a", pinned: true }, list)).toBe(true);
    expect(shownInMoved({ id: "h-a", pinned: false }, list)).toBe(false);
    expect(shownInMoved({ id: "h-b", pinned: true }, list)).toBe(false);
  });
});

describe("the Monitors section", () => {
  test("open first, then timed, then moved; the rest fold", () => {
    const list = [monitor("same"), monitor("moved"), monitor("closed"), monitor("old", { open: stretch("old", -5, null) }), monitor("new", { open: stretch("new", 3, null) })];
    const out = homeMonitors(list, [card("same", 2, 2), card("moved", 2, 5)], [stretch("closed", 8, 13)], mark);
    expect(out.rows.map((r) => r.monitor.id)).toEqual(["new", "old", "closed", "moved"]);
    expect(out).toMatchObject({ open: 2, active: 4, total: 5, more: "1 more, same as before" });
  });

  test("past the row limit the rest are in Watch", () => {
    const list = ["a", "b", "c"].map((id) => monitor(id, { open: stretch(id, 1, null) }));
    expect(homeMonitors(list, [], [], mark, 2)).toMatchObject({ active: 3, more: "1 more in Watch" });
  });

  test("every monitor listed: no line under them", () => {
    expect(homeMonitors([monitor("a", { open: stretch("a", 1, null) })], [], [], mark).more).toBeNull();
  });
});
