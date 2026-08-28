import { surroundingDefaultN } from "../query/surrounding";
import type { HistogramChartKind, HistogramIntervalId, HistogramSplit } from "../query/histogram";
import { formatChangeMarkLabel, type ChangeMark, type ChangeMarkKind } from "../shared/change-mark";
import { defaultLayout, type WidgetDef } from "../shared/widgets";
import type { FacetValue, Facets, HistogramBucket, LogEvent, SearchAggResult } from "./types";
import type { ContextMode } from "./context-mode";
import { eventKey, indexOfEventKey } from "./event-key";
import type { InspectTab } from "./inspect-tabs";
import { defaultSearchUrlState, type RangeMode, type SearchUrlState } from "./search-url";
import type { FingerprintCutSnap } from "./fingerprint-cut";

export function ordinalLabels(labels: string[]): string[] {
  const counts = new Map<string, number>();
  for (const label of labels) {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return labels.map((label) => {
    if ((counts.get(label) ?? 0) < 2) {
      return label;
    }
    const n = (seen.get(label) ?? 0) + 1;
    seen.set(label, n);
    return `${label} · ${n}`;
  });
}

export type WorkspaceKind = "search" | "follow" | "surroundings";

export type WorkspaceFollow = { key: string; value: string };

export type HistogramExploreOrigin = {
  range: RangeMode;
  from: string;
  to: string;
  live: boolean;
  step: HistogramIntervalId | null;
};

export type WorkspaceSeriesPaint = {
  histogram: HistogramBucket[];
  agg: SearchAggResult | null;
  total: number;
  values?: FacetValue[];
  fetchedAt?: number;
};

export type WorkspacePaint = {
  hunt: string;
  events: LogEvent[];
  histogram: HistogramBucket[];
  agg: SearchAggResult | null;
  seriesByKey: Record<string, WorkspaceSeriesPaint>;
  total: number;
  nextCursor: string | null;
  ingested: boolean;
  lastMs: number | null;
  error: string | null;
  facets: Facets;
  attrFacetValues: Record<string, FacetValue[]>;
  numericKeys: string[];
  metricNames: string[];
  attrKeyOptions: Array<{ k: string; n: number }>;
  lastTo: string | null;
  marks: ChangeMark[];
  markBefore: ChangeMark | null;
  markAfter: ChangeMark | null;
};

export type WorkspaceHunt = {
  q: string;
  range: RangeMode;
  from: string;
  to: string;
  live: boolean;
  step: HistogramIntervalId | null;
  agg: string | null;
  logsOn: boolean;
  split: HistogramSplit;
  attrFacets: string[];
  widgets: WidgetDef[];
};

export function workspaceHuntKey(input: WorkspaceHunt): string {
  const window =
    input.live || input.range !== "custom"
      ? `${input.range}|${input.live ? "1" : "0"}`
      : `custom|${input.from}|${input.to}`;
  return [
    input.q.trim(),
    window,
    input.step ?? "",
    input.agg ?? "",
    input.logsOn ? "1" : "0",
    input.split,
    [...input.attrFacets].sort().join(","),
    JSON.stringify(input.widgets),
  ].join("\n");
}

export function workspaceHuntKeyFromSnap(snap: WorkspaceSnap): string {
  return workspaceHuntKey({
    q: snap.q,
    range: snap.range,
    from: snap.from,
    to: snap.to,
    live: snap.live,
    step: snap.step,
    agg: snap.agg,
    logsOn: snap.logsOn,
    split: snap.split,
    attrFacets: snap.attrFacets,
    widgets: snap.widgets,
  });
}

export function isReaderKind(kind: WorkspaceKind): boolean {
  return kind === "surroundings";
}

export function shouldRestorePaint(snap: WorkspaceSnap): boolean {
  if (isReaderKind(snap.kind) || !snap.paint) {
    return false;
  }
  if (snap.paint.lastMs == null && snap.paint.error == null) {
    return false;
  }
  return snap.paint.hunt === workspaceHuntKeyFromSnap(snap);
}

/** Pin the stacked line so an empty table (Follow round-trip) cannot drop the overlay. */
export function snapPinnedEvent(input: {
  cut: FingerprintCutSnap | null;
  detailOpen: boolean;
  pinned: LogEvent | null;
  selected: LogEvent | undefined;
}): LogEvent | null {
  if (input.pinned) {
    return input.pinned;
  }
  if (input.cut && input.detailOpen) {
    return input.selected ?? null;
  }
  return null;
}

/** Last paint for a parked cut line — restore even when the hunt key drifted. */
export function shouldRestoreParkedCut(snap: WorkspaceSnap): boolean {
  return Boolean(
    snap.cut &&
      snap.detailOpen &&
      snap.paint &&
      (snap.paint.lastMs != null || snap.paint.error != null),
  );
}

export type ParkedCutLine = {
  event: LogEvent | null;
  index: number;
};

export function parkedCutLine(snap: WorkspaceSnap): ParkedCutLine | null {
  if (!snap.cut || !snap.detailOpen) {
    return null;
  }
  return {
    event: snap.pinnedEvent,
    index: snap.selectedIndex,
  };
}

export function selectionAfterReplace(
  park: ParkedCutLine | null,
  events: LogEvent[],
): {
  index: number;
  detailOpen: boolean;
  pinned: LogEvent | null;
} {
  if (!park) {
    return { index: 0, detailOpen: false, pinned: null };
  }
  if (park.event) {
    const idx = indexOfEventKey(events, eventKey(park.event));
    if (idx >= 0) {
      return { index: idx, detailOpen: true, pinned: null };
    }
    return { index: -1, detailOpen: true, pinned: park.event };
  }
  if (park.index >= 0 && park.index < events.length) {
    return { index: park.index, detailOpen: true, pinned: null };
  }
  return { index: 0, detailOpen: true, pinned: null };
}

/** Follow tab: new hunt, no parked cut overlay. Origin was already stamped. */
export function followChildSnap(
  origin: WorkspaceSnap,
  follow: {
    q: string;
    from: string;
    to: string;
    key: string;
    value: string;
  },
): WorkspaceSnap {
  return {
    ...origin,
    kind: "follow",
    q: follow.q,
    range: "custom",
    from: follow.from,
    to: follow.to,
    live: false,
    savedId: null,
    bind: {},
    follow: { key: follow.key, value: follow.value },
    explore: null,
    inspectTabs: [],
    activeInspect: null,
    surrAnchor: null,
    surrSel: null,
    focusMark: null,
    frozenFacets: null,
    frozenAttrFacetValues: null,
    paint: null,
    marksOff: [],
    marksMuted: [],
    cut: null,
    detailOpen: false,
    pinnedEvent: null,
    selectedIndex: 0,
  };
}

export type WorkspaceSnap = {
  kind: WorkspaceKind;
  q: string;
  range: RangeMode;
  from: string;
  to: string;
  live: boolean;
  savedId: string | null;
  bind: Record<string, string>;
  split: HistogramSplit;
  chart: HistogramChartKind;
  logScale: boolean;
  step: HistogramIntervalId | null;
  agg: string | null;
  replaceY: boolean;
  logsOn: boolean;
  widgets: WidgetDef[];
  attrFacets: string[];
  cols: string[];
  explore: HistogramExploreOrigin | null;
  follow: WorkspaceFollow | null;
  inspectTabs: InspectTab[];
  activeInspect: InspectTab | null;
  aroundN: number;
  aroundMode: ContextMode;
  selectedIndex: number;
  detailOpen: boolean;
  pinnedEvent: LogEvent | null;
  surrAnchor: LogEvent | null;
  surrSel: LogEvent | null;
  focusMark: ChangeMark | null;
  frozenFacets: Facets | null;
  frozenAttrFacetValues: Record<string, FacetValue[]> | null;
  paint: WorkspacePaint | null;
  marksOff: ChangeMarkKind[];
  marksMuted: string[];
  cut: FingerprintCutSnap | null;
};

export type Workspace = {
  id: number;
  kind: WorkspaceKind;
  label: string;
  board?: boolean;
  snap: WorkspaceSnap;
};

export function urlSearchSnap(state: SearchUrlState): WorkspaceSnap {
  return {
    ...blankSearchSnap(),
    q: state.q,
    range: state.range,
    from: state.from,
    to: state.to,
    live: state.live,
    savedId: state.saved,
    bind: state.bind,
    split: state.split,
    chart: state.chart,
    logScale: state.logScale,
    step: state.step,
    agg: state.agg,
    replaceY: state.replaceY,
    logsOn: state.logs,
    widgets: state.widgets,
    attrFacets: state.attrFacets,
    cols: state.cols,
  };
}

export function stampWorkspace(
  list: Workspace[],
  id: number,
  snap: WorkspaceSnap,
  label: string,
  board?: boolean,
): Workspace[] {
  return list.map((item) =>
    item.id === id
      ? { ...item, kind: snap.kind, label, snap, board: board ?? item.board }
      : item,
  );
}

export function blankSearchSnap(): WorkspaceSnap {
  const boot = defaultSearchUrlState();
  return {
    kind: "search",
    q: boot.q,
    range: boot.range,
    from: boot.from,
    to: boot.to,
    live: boot.live,
    savedId: null,
    bind: {},
    split: boot.split,
    chart: boot.chart,
    logScale: boot.logScale,
    step: boot.step,
    agg: boot.agg,
    replaceY: boot.replaceY,
    logsOn: boot.logs,
    widgets: defaultLayout().widgets,
    attrFacets: [],
    cols: [],
    explore: null,
    follow: null,
    inspectTabs: [],
    activeInspect: null,
    aroundN: surroundingDefaultN,
    aroundMode: "all",
    selectedIndex: 0,
    detailOpen: false,
    pinnedEvent: null,
    surrAnchor: null,
    surrSel: null,
    focusMark: null,
    frozenFacets: null,
    frozenAttrFacetValues: null,
    paint: null,
    marksOff: [],
    marksMuted: [],
    cut: null,
  };
}

export function surroundingsLabel(event: LogEvent): string {
  return `${event.service} ${event.ts.slice(11, 19)}`;
}

export function workspaceLiveLabel(input: {
  kind: WorkspaceKind;
  q: string;
  savedName: string | null;
  savedDirty: boolean;
  follow: WorkspaceFollow | null;
  surrAnchor: LogEvent | null;
  focusMark?: ChangeMark | null;
  board?: boolean;
  boardBinds?: string[];
}): string {
  if (input.kind === "surroundings") {
    if (input.focusMark) {
      return formatChangeMarkLabel(input.focusMark);
    }
    if (input.surrAnchor) {
      return surroundingsLabel(input.surrAnchor);
    }
  }
  if (input.kind === "follow" && input.follow) {
    return `${input.follow.key}:${input.follow.value}`;
  }
  if (input.board && input.savedName) {
    const binds = (input.boardBinds ?? []).filter((item) => item.length > 0);
    return binds.length > 0
      ? `${input.savedName} · ${binds.join(" · ")}`
      : input.savedName;
  }
  if (input.savedName && !input.savedDirty) {
    return input.savedName;
  }
  const q = input.q.trim();
  return q.length > 0 ? q : "All logs";
}

export function insertWorkspace(
  list: Workspace[],
  currentId: number,
  next: Workspace,
  atEnd: boolean,
): Workspace[] {
  if (atEnd) {
    return [...list, next];
  }
  const at = list.findIndex((item) => item.id === currentId) + 1;
  return [...list.slice(0, at), next, ...list.slice(at)];
}

export function closeWorkspace(
  list: Workspace[],
  id: number,
): { list: Workspace[]; nextId: number | null } {
  if (list.length < 2) {
    return { list, nextId: null };
  }
  const i = list.findIndex((item) => item.id === id);
  const next = list.filter((item) => item.id !== id);
  if (i === -1) {
    return { list, nextId: null };
  }
  const pick = next[Math.min(i, next.length - 1)];
  return { list: next, nextId: pick?.id ?? null };
}

export function findFollowWorkspace(
  list: Workspace[],
  key: string,
  value: string,
): Workspace | undefined {
  return list.find(
    (item) =>
      item.kind === "follow" &&
      item.snap.follow?.key === key &&
      item.snap.follow?.value === value,
  );
}

export function findSurroundingsWorkspace(
  list: Workspace[],
  event: LogEvent,
): Workspace | undefined {
  const key = eventKey(event);
  return list.find(
    (item) =>
      item.kind === "surroundings" &&
      item.snap.surrAnchor !== null &&
      eventKey(item.snap.surrAnchor) === key,
  );
}

export function findMarkFocusWorkspace(
  list: Workspace[],
  markId: string,
): Workspace | undefined {
  return list.find(
    (item) =>
      item.kind === "surroundings" && item.snap.focusMark?.id === markId,
  );
}

export type FocusMarkDecision =
  | { action: "stay" }
  | { action: "recenter" }
  | { action: "switch"; id: number }
  | { action: "open-beside" };

export type OpenSurroundingsDecision =
  | { action: "stay" }
  | { action: "recenter" }
  | { action: "open-beside" };

/** Focus in logs: reuse this Surroundings tab, switch to it, or open beside. */
export function decideFocusMarkInLogs(
  current: { kind: WorkspaceKind; focusMarkId: string | null },
  list: Workspace[],
  markId: string,
): FocusMarkDecision {
  if (current.kind === "surroundings" && current.focusMarkId === markId) {
    return { action: "stay" };
  }
  if (current.kind === "surroundings") {
    return { action: "recenter" };
  }
  const existing = findMarkFocusWorkspace(list, markId);
  if (existing) {
    return { action: "switch", id: existing.id };
  }
  return { action: "open-beside" };
}

/** Footer Surroundings: re-center this reader, or open beside. */
export function decideOpenSurroundings(
  current: { kind: WorkspaceKind; surrAnchor: LogEvent | null },
  event: LogEvent,
): OpenSurroundingsDecision {
  if (
    current.kind === "surroundings" &&
    current.surrAnchor &&
    eventKey(event) === eventKey(current.surrAnchor)
  ) {
    return { action: "stay" };
  }
  if (current.kind === "surroundings") {
    return { action: "recenter" };
  }
  return { action: "open-beside" };
}

function surroundingsReaderSnap(
  hunt: WorkspaceSnap,
  frozen: {
    frozenFacets: Facets | null;
    frozenAttrFacetValues: Record<string, FacetValue[]> | null;
  },
): WorkspaceSnap {
  return {
    ...hunt,
    kind: "surroundings",
    follow: null,
    explore: null,
    inspectTabs: [],
    activeInspect: null,
    aroundN: surroundingDefaultN,
    aroundMode: "all",
    surrSel: null,
    paint: null,
    frozenFacets: frozen.frozenFacets,
    frozenAttrFacetValues: frozen.frozenAttrFacetValues,
    cut: null,
  };
}

export function surroundingsEventSnap(
  hunt: WorkspaceSnap,
  event: LogEvent,
  frozen: {
    frozenFacets: Facets | null;
    frozenAttrFacetValues: Record<string, FacetValue[]> | null;
  },
): WorkspaceSnap {
  return {
    ...surroundingsReaderSnap(hunt, frozen),
    surrAnchor: event,
    focusMark: null,
  };
}

export function surroundingsMarkSnap(
  hunt: WorkspaceSnap,
  mark: ChangeMark,
  frozen: {
    frozenFacets: Facets | null;
    frozenAttrFacetValues: Record<string, FacetValue[]> | null;
  },
): WorkspaceSnap {
  return {
    ...surroundingsReaderSnap(hunt, frozen),
    live: false,
    logsOn: true,
    surrAnchor: null,
    focusMark: mark,
  };
}

export function duplicateSnap(snap: WorkspaceSnap): WorkspaceSnap {
  return {
    ...snap,
    inspectTabs: [],
    activeInspect: null,
    surrSel: isReaderKind(snap.kind) ? null : snap.surrSel,
  };
}
