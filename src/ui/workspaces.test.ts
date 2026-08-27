import { describe, expect, test } from "bun:test";
import type { LogEvent } from "./types";
import { defaultSearchUrlState } from "./search-url";
import type { ChangeMark } from "../shared/change-mark";
import {
  blankSearchSnap,
  closeWorkspace,
  decideFocusMarkInLogs,
  decideOpenSurroundings,
  duplicateSnap,
  findFollowWorkspace,
  findMarkFocusWorkspace,
  findSurroundingsWorkspace,
  insertWorkspace,
  ordinalLabels,
  stampWorkspace,
  surroundingsEventSnap,
  surroundingsLabel,
  surroundingsMarkSnap,
  shouldRestorePaint,
  urlSearchSnap,
  workspaceHuntKeyFromSnap,
  workspaceLiveLabel,
  type Workspace,
} from "./workspaces";

function ev(ts: string, service: string): LogEvent {
  return { ts, service, level: "info", message: "m" };
}

function deployMark(id = "mk_1"): ChangeMark {
  return {
    id,
    ts: "2026-08-25T16:29:37.732Z",
    end_ts: null,
    kind: "deploy",
    service: "billing",
    title: "v0.9",
    attrs: {},
  };
}

function ws(id: number, kind: Workspace["kind"] = "search"): Workspace {
  return { id, kind, label: "All logs", snap: blankSearchSnap() };
}

describe("workspaceLiveLabel", () => {
  test("search uses q, then All logs", () => {
    expect(
      workspaceLiveLabel({
        kind: "search",
        q: "level:error",
        savedName: null,
        savedDirty: false,
        follow: null,
        surrAnchor: null,
      }),
    ).toBe("level:error");
    expect(
      workspaceLiveLabel({
        kind: "search",
        q: "  ",
        savedName: null,
        savedDirty: false,
        follow: null,
        surrAnchor: null,
      }),
    ).toBe("All logs");
  });

  test("clean saved name wins until edited", () => {
    expect(
      workspaceLiveLabel({
        kind: "search",
        q: "level:error",
        savedName: "errors",
        savedDirty: false,
        follow: null,
        surrAnchor: null,
      }),
    ).toBe("errors");
    expect(
      workspaceLiveLabel({
        kind: "search",
        q: "level:error",
        savedName: "errors",
        savedDirty: true,
        follow: null,
        surrAnchor: null,
      }),
    ).toBe("level:error");
  });

  test("board name plus bound values; unbound is the board name only", () => {
    expect(
      workspaceLiveLabel({
        kind: "search",
        q: "level:warn status:4*",
        savedName: "HTTP attacks by install",
        savedDirty: false,
        follow: null,
        surrAnchor: null,
        board: true,
        boardBinds: ["acme-eu"],
      }),
    ).toBe("HTTP attacks by install · acme-eu");
    expect(
      workspaceLiveLabel({
        kind: "search",
        q: "level:warn status:4*",
        savedName: "HTTP attacks by install",
        savedDirty: false,
        follow: null,
        surrAnchor: null,
        board: true,
        boardBinds: [],
      }),
    ).toBe("HTTP attacks by install");
  });

  test("follow and surroundings use the thing the tab is", () => {
    expect(
      workspaceLiveLabel({
        kind: "follow",
        q: "request_id:abc",
        savedName: null,
        savedDirty: false,
        follow: { key: "request_id", value: "abc" },
        surrAnchor: null,
      }),
    ).toBe("request_id:abc");
    expect(surroundingsLabel(ev("2026-08-16T14:59:51.000Z", "worker"))).toBe(
      "worker 14:59:51",
    );
  });

  test("Surroundings focused on a mark uses the mark label", () => {
    expect(
      workspaceLiveLabel({
        kind: "surroundings",
        q: "level:error",
        savedName: null,
        savedDirty: false,
        follow: null,
        surrAnchor: null,
        focusMark: deployMark(),
      }),
    ).toBe("deployed: billing v0.9");
  });
});

describe("insertWorkspace", () => {
  test("derived tabs land beside the current tab; New goes to the end", () => {
    const list = [ws(1), ws(2)];
    const derived = insertWorkspace(list, 1, ws(3, "follow"), false);
    expect(derived.map((item) => item.id)).toEqual([1, 3, 2]);
    const fresh = insertWorkspace(list, 1, ws(3), true);
    expect(fresh.map((item) => item.id)).toEqual([1, 2, 3]);
  });

  test("has no workspace cap", () => {
    const list = [1, 2, 3, 4, 5].map((id) => ws(id));
    expect(insertWorkspace(list, 5, ws(6), true)).toHaveLength(6);
  });
});

describe("ordinalLabels", () => {
  test("only exact repeats get an ordinal", () => {
    expect(ordinalLabels(["Prod 5xx", "All logs", "Prod 5xx"])).toEqual([
      "Prod 5xx · 1",
      "All logs",
      "Prod 5xx · 2",
    ]);
  });
});

describe("closeWorkspace", () => {
  test("cannot close the last tab", () => {
    const only = ws(1);
    expect(closeWorkspace([only], 1)).toEqual({ list: [only], nextId: null });
  });

  test("closing the active tab selects a neighbor", () => {
    const { list, nextId } = closeWorkspace([ws(1), ws(2), ws(3)], 2);
    expect(list.map((item) => item.id)).toEqual([1, 3]);
    expect(nextId).toBe(3);
  });
});

describe("find + duplicate", () => {
  test("finds follow and surroundings by identity", () => {
    const follow = ws(2, "follow");
    follow.snap.kind = "follow";
    follow.snap.follow = { key: "request_id", value: "abc" };
    const surr = ws(3, "surroundings");
    const event = ev("2026-08-16T14:59:51.000Z", "worker");
    surr.snap.kind = "surroundings";
    surr.snap.surrAnchor = event;
    const list = [ws(1), follow, surr];
    expect(findFollowWorkspace(list, "request_id", "abc")?.id).toBe(2);
    expect(findSurroundingsWorkspace(list, event)?.id).toBe(3);
  });

  test("finds Surroundings focused on a mark by mark id", () => {
    const markTab = ws(4, "surroundings");
    markTab.snap.kind = "surroundings";
    markTab.snap.focusMark = deployMark("mk_3a479925");
    expect(findMarkFocusWorkspace([ws(1), markTab], "mk_3a479925")?.id).toBe(4);
    expect(findMarkFocusWorkspace([ws(1), markTab], "mk_other")).toBeUndefined();
  });

  test("event Surroundings and mark Surroundings are not the same tab", () => {
    const event = ev("2026-08-16T14:59:51.000Z", "worker");
    const eventTab = ws(3, "surroundings");
    eventTab.snap.kind = "surroundings";
    eventTab.snap.surrAnchor = event;
    const markTab = ws(4, "surroundings");
    markTab.snap.kind = "surroundings";
    markTab.snap.focusMark = deployMark("mk_3a479925");
    const list = [ws(1), eventTab, markTab];
    expect(findSurroundingsWorkspace(list, event)?.id).toBe(3);
    expect(findMarkFocusWorkspace(list, "mk_3a479925")?.id).toBe(4);
    expect(findMarkFocusWorkspace([eventTab], "mk_3a479925")).toBeUndefined();
    expect(findSurroundingsWorkspace([markTab], event)).toBeUndefined();
  });

  test("Focus in logs stays, re-centers this reader, switches, or opens beside", () => {
    const mark = deployMark("mk_3a479925");
    const markTab = ws(4, "surroundings");
    markTab.snap.kind = "surroundings";
    markTab.snap.focusMark = mark;
    const list = [ws(1), markTab];
    expect(
      decideFocusMarkInLogs(
        { kind: "surroundings", focusMarkId: mark.id },
        list,
        mark.id,
      ),
    ).toEqual({ action: "stay" });
    expect(
      decideFocusMarkInLogs(
        { kind: "surroundings", focusMarkId: "mk_other" },
        list,
        mark.id,
      ),
    ).toEqual({ action: "recenter" });
    expect(
      decideFocusMarkInLogs(
        { kind: "surroundings", focusMarkId: null },
        list,
        mark.id,
      ),
    ).toEqual({ action: "recenter" });
    expect(
      decideFocusMarkInLogs({ kind: "search", focusMarkId: null }, list, mark.id),
    ).toEqual({ action: "switch", id: 4 });
    expect(
      decideFocusMarkInLogs({ kind: "search", focusMarkId: null }, [ws(1)], mark.id),
    ).toEqual({ action: "open-beside" });
    expect(
      decideFocusMarkInLogs({ kind: "follow", focusMarkId: null }, [ws(1)], mark.id),
    ).toEqual({ action: "open-beside" });
  });

  test("footer Surroundings re-centers a mark-focused reader onto the event", () => {
    const event = ev("2026-08-16T14:59:51.000Z", "worker");
    const other = ev("2026-08-16T15:00:00.000Z", "api");
    expect(
      decideOpenSurroundings(
        { kind: "surroundings", surrAnchor: event },
        event,
      ),
    ).toEqual({ action: "stay" });
    expect(
      decideOpenSurroundings(
        { kind: "surroundings", surrAnchor: null },
        event,
      ),
    ).toEqual({ action: "recenter" });
    expect(
      decideOpenSurroundings(
        { kind: "surroundings", surrAnchor: other },
        event,
      ),
    ).toEqual({ action: "recenter" });
    expect(
      decideOpenSurroundings({ kind: "search", surrAnchor: null }, event),
    ).toEqual({ action: "open-beside" });
  });

  test("mark Surroundings snap is Live off with no event anchor", () => {
    const hunt = blankSearchSnap();
    hunt.q = "level:error";
    hunt.live = true;
    hunt.logsOn = false;
    hunt.inspectTabs = [
      {
        kind: "trace",
        key: "trace_id",
        value: "aa",
        ts: "2026-08-16T14:59:51.000Z",
        service: "nginx",
      },
    ];
    const mark = deployMark();
    const frozen = {
      frozenFacets: { level: [], service: [], host: [] },
      frozenAttrFacetValues: { path: [] },
    };
    const snap = surroundingsMarkSnap(hunt, mark, frozen);
    expect(snap.kind).toBe("surroundings");
    expect(snap.live).toBe(false);
    expect(snap.logsOn).toBe(true);
    expect(snap.q).toBe("level:error");
    expect(snap.surrAnchor).toBeNull();
    expect(snap.focusMark).toEqual(mark);
    expect(snap.aroundN).toBe(50);
    expect(snap.aroundMode).toBe("all");
    expect(snap.inspectTabs).toEqual([]);
    expect(snap.paint).toBeNull();
    expect(snap.frozenFacets).toEqual(frozen.frozenFacets);
    expect(
      workspaceLiveLabel({
        kind: snap.kind,
        q: snap.q,
        savedName: null,
        savedDirty: false,
        follow: null,
        surrAnchor: snap.surrAnchor,
        focusMark: snap.focusMark,
      }),
    ).toBe("deployed: billing v0.9");
  });

  test("event Surroundings snap clears the mark and keeps hunt Live", () => {
    const hunt = blankSearchSnap();
    hunt.live = true;
    hunt.focusMark = deployMark();
    const event = ev("2026-08-16T14:59:51.000Z", "worker");
    const snap = surroundingsEventSnap(hunt, event, {
      frozenFacets: null,
      frozenAttrFacetValues: null,
    });
    expect(snap.kind).toBe("surroundings");
    expect(snap.live).toBe(true);
    expect(snap.surrAnchor).toBe(event);
    expect(snap.focusMark).toBeNull();
    expect(surroundingsLabel(event)).toBe("worker 14:59:51");
  });

  test("stamp writes snap and label onto that id", () => {
    const snap = blankSearchSnap();
    snap.q = "level:error";
    const next = stampWorkspace([ws(1), ws(2)], 1, snap, "level:error");
    expect(next[0]?.label).toBe("level:error");
    expect(next[0]?.snap.q).toBe("level:error");
    expect(next[1]?.label).toBe("All logs");
  });

  test("urlSearchSnap copies promoted columns from the hunt URL", () => {
    const boot = defaultSearchUrlState();
    boot.cols = ["path", "status"];
    expect(urlSearchSnap(boot).cols).toEqual(["path", "status"]);
    expect(urlSearchSnap(defaultSearchUrlState()).cols).toEqual([]);
  });

  test("duplicate drops inspect tabs", () => {
    const snap = blankSearchSnap();
    snap.inspectTabs = [
      {
        kind: "trace",
        key: "trace_id",
        value: "aa",
        ts: "2026-08-16T14:59:51.000Z",
        service: "nginx",
      },
    ];
    snap.activeInspect = snap.inspectTabs[0] ?? null;
    const next = duplicateSnap(snap);
    expect(next.inspectTabs).toEqual([]);
    expect(next.activeInspect).toBeNull();
  });
});

describe("workspace hunt / paint", () => {
  function paint(
    hunt: string,
    extra?: { lastMs?: number | null; error?: string | null },
  ) {
    return {
      hunt,
      events: [],
      histogram: [],
      agg: null,
      seriesByKey: {},
      total: 0,
      nextCursor: null,
      ingested: true,
      lastMs: extra && "lastMs" in extra ? extra.lastMs! : 12,
      error: extra?.error ?? null,
      facets: { level: [], service: [], host: [] },
      attrFacetValues: {},
      numericKeys: [],
      metricNames: [],
      attrKeyOptions: [],
      lastTo: null,
      marks: [],
      markBefore: null,
      markAfter: null,
    };
  }

  test("custom window is in the hunt; live slides are not", () => {
    const a = blankSearchSnap();
    a.range = "custom";
    a.from = "2026-08-14T04:30:00.000Z";
    a.to = "2026-08-16T04:30:00.000Z";
    a.live = false;
    const b = { ...a, from: "2026-08-14T05:30:00.000Z" };
    expect(workspaceHuntKeyFromSnap(a)).not.toBe(workspaceHuntKeyFromSnap(b));
    a.live = true;
    b.live = true;
    expect(workspaceHuntKeyFromSnap(a)).toBe(workspaceHuntKeyFromSnap(b));
  });

  test("relative range ignores from/to", () => {
    const a = blankSearchSnap();
    a.range = "1h";
    a.from = "x";
    a.to = "y";
    const b = { ...a, from: "z", to: "w" };
    expect(workspaceHuntKeyFromSnap(a)).toBe(workspaceHuntKeyFromSnap(b));
  });

  test("shouldRestorePaint requires matching hunt and a finished result", () => {
    const snap = blankSearchSnap();
    snap.q = "user_id:u-1";
    snap.range = "custom";
    snap.from = "a";
    snap.to = "b";
    const hunt = workspaceHuntKeyFromSnap(snap);
    snap.paint = paint(hunt);
    expect(shouldRestorePaint(snap)).toBe(true);
    snap.q = "user_id:u-2";
    expect(shouldRestorePaint(snap)).toBe(false);
    snap.q = "user_id:u-1";
    snap.paint = paint(hunt, { lastMs: null, error: null });
    expect(shouldRestorePaint(snap)).toBe(false);
    snap.paint = paint(hunt, { lastMs: null, error: "Search failed" });
    expect(shouldRestorePaint(snap)).toBe(true);
    snap.kind = "surroundings";
    snap.paint = paint(hunt);
    expect(shouldRestorePaint(snap)).toBe(false);
  });

  test("duplicate keeps paint and promoted columns; blank starts empty", () => {
    const snap = blankSearchSnap();
    snap.paint = paint(workspaceHuntKeyFromSnap(snap));
    snap.cols = ["path", "status"];
    const next = duplicateSnap(snap);
    expect(next.paint?.lastMs).toBe(12);
    expect(next.cols).toEqual(["path", "status"]);
    expect(blankSearchSnap().cols).toEqual([]);
    expect(blankSearchSnap().marksOff).toEqual([]);
    expect(blankSearchSnap().marksMuted).toEqual([]);
    const follow = { ...snap, kind: "follow" as const, q: "user_id:u-1", savedId: null };
    expect(follow.cols).toEqual(["path", "status"]);
  });

  test("duplicate keeps per-hunt mark mutes; they are not in the hunt key", () => {
    const snap = blankSearchSnap();
    snap.marksOff = ["flag"];
    snap.marksMuted = ["mk_1"];
    const next = duplicateSnap(snap);
    expect(next.marksOff).toEqual(["flag"]);
    expect(next.marksMuted).toEqual(["mk_1"]);
    expect(workspaceHuntKeyFromSnap(snap)).toBe(
      workspaceHuntKeyFromSnap({ ...snap, marksOff: [], marksMuted: [] }),
    );
  });

  test("promoted columns are paint-only — not in the hunt key", () => {
    const snap = blankSearchSnap();
    const hunt = workspaceHuntKeyFromSnap(snap);
    snap.cols = ["path", "status", "user_id"];
    expect(workspaceHuntKeyFromSnap(snap)).toBe(hunt);
  });
});
