import { fingerprintCutFetchKey } from "./fingerprint-cut";
import type { ChangeMark } from "../shared/change-mark";

/** Same freeze as the cut: mark + openedAt. Session-only, not the URL. */
export type CompareFoldSnap = {
  mark: ChangeMark;
  openedAt: string;
};

/** Live polls slide from/to; the fold stays frozen until q, span, or series changes. */
export function compareFoldFetchKey(input: {
  q: string;
  live: boolean;
  spanMs: number;
  from: string;
  to: string;
  agg: string | null;
  metric: string | null;
  ml: string;
}): string {
  return `${fingerprintCutFetchKey(input)}\0${input.agg ?? ""}\0${input.metric ?? ""}\0${input.ml}`;
}
