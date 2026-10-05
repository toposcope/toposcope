import { fingerprintCutFetchKey, fingerprintCutHuntWindows } from "./fingerprint-cut";
import type { ChangeMark } from "../shared/change-mark";
import { isoFromLocal } from "./search-url";
import { widgetGapPx, widgetRowPx } from "../shared/widgets";
import { maxMetricLabels, parseMetricLabels } from "../shared/metric";
import type { HistogramSplit } from "../query/histogram";

/** A split narrows the existing metric scope; it cannot replace a pinned matcher. */
export function compareFoldMetricLabels(ml: string, split: HistogramSplit, key: string): string | null {
  if (split === "none" || key === "other") return ml;
  const labels = parseMetricLabels(ml);
  if (split in labels) return labels[split] === key ? ml : null;
  if (Object.keys(labels).length >= maxMetricLabels) {
    throw new Error(`Compare split exceeds the ${maxMetricLabels} metric label matcher cap`);
  }
  return `${ml ? `${ml},` : ""}${split}:${key}`;
}

/** Compare reads the hunt clock; painted bucket boundaries only position glyphs. */
export function compareFoldWindows(input: {
  mark: ChangeMark; openedAt: string; from: string; to: string; live: boolean;
  huntFromMs: number; huntToMs: number;
}) {
  const fromMs = Date.parse(isoFromLocal(input.from) ?? "");
  const toMs = input.live ? Date.parse(input.openedAt) : Date.parse(isoFromLocal(input.to) ?? "");
  return fingerprintCutHuntWindows(input.mark, input.openedAt,
    Number.isFinite(fromMs) ? fromMs : input.huntFromMs,
    Number.isFinite(toMs) ? toMs : input.huntToMs);
}

/** Temporary paint space, never a change to the saved widget geometry. */
export function compareFoldExtraRows(lines: number): number {
  return Math.ceil(Math.max(0, lines - 1) * 30 / (widgetRowPx + widgetGapPx));
}

/** Same freeze as the cut: mark + openedAt. Session-only, not the URL. */
export type CompareFoldSnap = {
  mark: ChangeMark;
  openedAt: string;
};

/** Live polls slide from/to; the fold stays frozen until q, span, split, or series changes. */
export function compareFoldFetchKey(input: {
  q: string;
  live: boolean;
  spanMs: number;
  from: string;
  to: string;
  agg: string | null;
  metric: string | null;
  ml: string;
  split: string;
}): string {
  return `${fingerprintCutFetchKey(input)}\0${input.agg ?? ""}\0${input.metric ?? ""}\0${input.ml}\0${input.split}`;
}
