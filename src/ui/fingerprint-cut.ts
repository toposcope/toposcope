import {
  fingerprintCutMinBeforeMs,
  fingerprintCutWindows,
  formatFingerprintCutDuration,
  type FingerprintCutResult,
  type FingerprintCutWindows,
} from "../shared/fingerprint-cut";
import type { ChangeMark } from "../shared/change-mark";
import { formatEventClock } from "./event-time";
import { isoFromLocal } from "./search-url";

export type FingerprintCutSnap = {
  mark: ChangeMark;
  openedAt: string;
  result: FingerprintCutResult | null;
};

export type CutRailSurface = "cut" | "detail" | "none";

/** Which card owns the results rail. Cut is the floor; a selected line pushes detail. */
export function cutRailSurface(input: {
  hasCut: boolean;
  detailOpen: boolean;
  hasSelected: boolean;
  inspectOpen: boolean;
  isSurr: boolean;
  boardOn: boolean;
}): CutRailSurface {
  if (input.isSurr || input.boardOn) {
    return "none";
  }
  if (input.hasCut && input.inspectOpen) {
    return "cut";
  }
  if (input.hasCut && input.detailOpen && input.hasSelected) {
    return "detail";
  }
  if (input.hasCut) {
    return "cut";
  }
  if (input.inspectOpen) {
    return "none";
  }
  if (input.detailOpen && input.hasSelected) {
    return "detail";
  }
  return "none";
}

export function cutCrumbLabel(
  result: FingerprintCutResult | null,
  fallbackTitle: string,
): string {
  const sets = result?.sets;
  if (!sets?.length) {
    return `Cut — ${fallbackTitle}`;
  }
  return `Cut — ${sets
    .filter((s) => !s.waiting)
    .map((s) => `${s.name.toLowerCase()} ${s.count}`)
    .join(" · ")}`;
}

/** Live polls slide from/to; the cut stays frozen until q or span changes. */
export function fingerprintCutFetchKey(input: {
  q: string;
  live: boolean;
  spanMs: number;
  from: string;
  to: string;
}): string {
  return input.live
    ? `${input.q}\0live\0${input.spanMs}`
    : `${input.q}\0${input.from}\0${input.to}`;
}

/** Compare passes no minimum and keeps equal sides; Fingerprints passes fingerprintCutMinBeforeMs. */
export function fingerprintCutHuntWindows(
  mark: ChangeMark,
  openedAt: string,
  huntFromMs: number,
  huntToMs: number,
  minBeforeMs = 0,
): FingerprintCutWindows {
  return fingerprintCutWindows({
    markTs: Date.parse(mark.ts),
    markEndTs: mark.end_ts ? Date.parse(mark.end_ts) : null,
    kind: mark.kind,
    huntFrom: huntFromMs,
    huntTo: huntToMs,
    openedAt: Date.parse(openedAt),
    minBeforeMs,
  });
}

/** The returned windows own both the numbers and their labels while a new read is pending. */
export function fingerprintCutViewWindows(input: {
  mark: ChangeMark;
  openedAt: string;
  range: string;
  from: string;
  to: string;
  spanMs: number;
  fromMs: number;
  toMs: number;
  result: FingerprintCutResult | null;
}): FingerprintCutWindows {
  const openedMs = Date.parse(input.openedAt);
  const custom = input.range === "custom";
  const fromMs = custom ? Date.parse(isoFromLocal(input.from) ?? "") : openedMs - input.spanMs;
  const toMs = custom ? Date.parse(isoFromLocal(input.to) ?? "") : openedMs;
  const huntFrom = Number.isFinite(fromMs) ? fromMs : input.fromMs;
  const huntTo = Number.isFinite(toMs) ? toMs : input.toMs;
  const fallback = fingerprintCutHuntWindows(
    input.mark,
    input.openedAt,
    huntFrom,
    huntTo,
    fingerprintCutMinBeforeMs,
  );
  if (!input.result) return fallback;
  const returned = input.result.windows;
  const beforeFrom = Date.parse(returned.beforeFrom);
  return {
    ...fallback,
    afterFrom: Date.parse(returned.afterFrom),
    afterTo: Date.parse(returned.afterTo),
    beforeFrom,
    beforeTo: Date.parse(returned.beforeTo),
    sideMs: returned.sideMs,
    beforeMs: returned.beforeMs ?? returned.sideMs,
    waiting: returned.waiting ?? false,
    banded: returned.banded,
    dead: returned.dead,
    pastPlotFrom: beforeFrom < huntFrom,
    openIncident: input.mark.kind === "incident" && !returned.banded,
  };
}

export function formatCutWindowLines(
  windows: FingerprintCutWindows,
  nowMs: number,
): { k: string; v: string }[] {
  if (windows.dead) {
    return [];
  }
  const fromMs = windows.beforeFrom;
  const spanMs = Math.max(1, windows.afterTo - windows.beforeFrom);
  const stamp = (ms: number) =>
    formatEventClock(new Date(ms).toISOString(), {
      format: "compact",
      fromMs,
      spanMs,
      nowMs,
      precision: "s",
    });
  const after = formatFingerprintCutDuration(windows.sideMs);
  const before = windows.waiting
    ? `${formatFingerprintCutDuration(windows.beforeMs)}, at least`
    : `equal ${after}`;
  const cutAt = formatEventClock(new Date(windows.afterFrom).toISOString(), {
    format: "full",
    fromMs,
    spanMs,
  }).slice(5);
  return [
    { k: "cut at", v: cutAt },
    {
      k: windows.banded ? "band" : "after",
      v: `${stamp(windows.afterFrom)} → ${stamp(windows.afterTo)} · ${after}`,
    },
    {
      k: "before",
      v: `${stamp(windows.beforeFrom)} → ${stamp(windows.beforeTo)} · ${before}`,
    },
  ];
}

/** A row's count tooltip says each side's length when they differ. */
export function cutCountTitle(windows: FingerprintCutWindows): string {
  if (!windows.waiting) {
    return "events before → after, equal windows";
  }
  return `events ${formatFingerprintCutDuration(windows.beforeMs)} before → ${formatFingerprintCutDuration(windows.sideMs)} after`;
}

/** "An error quiet for 18 minutes has not stopped." — the waiting Stopped in words. */
export function cutWaitingWords(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes >= 1) {
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const seconds = Math.max(1, Math.floor(ms / 1000));
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}
