import {
  fingerprintCutWindows,
  formatFingerprintCutDuration,
  type FingerprintCutResult,
  type FingerprintCutWindows,
} from "../shared/fingerprint-cut";
import type { ChangeMark } from "../shared/change-mark";
import { formatEventClock } from "./event-time";

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
  return `Cut — ${sets.map((s) => `${s.name.toLowerCase()} ${s.count}`).join(" · ")}`;
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

export function fingerprintCutHuntWindows(
  mark: ChangeMark,
  openedAt: string,
  huntFromMs: number,
  huntToMs: number,
): FingerprintCutWindows {
  return fingerprintCutWindows({
    markTs: Date.parse(mark.ts),
    markEndTs: mark.end_ts ? Date.parse(mark.end_ts) : null,
    kind: mark.kind,
    huntFrom: huntFromMs,
    huntTo: huntToMs,
    openedAt: Date.parse(openedAt),
  });
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
  const equal = `equal ${formatFingerprintCutDuration(windows.sideMs)}`;
  return [
    {
      k: windows.banded ? "band" : "after",
      v: `${stamp(windows.afterFrom)} → ${stamp(windows.afterTo)}`,
    },
    {
      k: "before",
      v: `${stamp(windows.beforeFrom)} → ${stamp(windows.beforeTo)} · ${equal}`,
    },
  ];
}
