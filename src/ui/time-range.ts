import {
  parseRangeMs,
  parseRangeParts,
  partsFromMs,
  type RangeUnit,
} from "../query/relative";
import {
  absWindowOk,
  clampAbsWindow,
  utcDayStart,
  type AbsField,
} from "./absolute-range";
import { rangeDurationMs } from "./fill-histogram";
import { toLocalInput, type RangeMode } from "./search-url";

export type { AbsField };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const SEARCH_SLOW_AFTER_MS = 5000;

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

export function formatSpanShort(ms: number): string {
  if (ms >= DAY_MS && ms % DAY_MS === 0) {
    return `${ms / DAY_MS}d`;
  }
  if (ms >= HOUR_MS && ms % HOUR_MS === 0) {
    return `${ms / HOUR_MS}h`;
  }
  if (ms >= HOUR_MS) {
    return `${Math.round(ms / HOUR_MS)}h`;
  }
  if (ms >= MINUTE_MS) {
    return `${Math.round(ms / MINUTE_MS)}m`;
  }
  if (ms >= 1000) {
    return `${Math.round(ms / 1000)}s`;
  }
  return `${Math.max(1, Math.round(ms))}ms`;
}

export function formatCustomRangeLabel(
  fromMs: number,
  toMs: number,
  nowMs = Date.now(),
): string {
  const span = Math.max(1, toMs - fromMs);
  const a = new Date(fromMs);
  const b = new Date(toMs);
  const needMs = a.getUTCMilliseconds() > 0 || b.getUTCMilliseconds() > 0;
  const needS = needMs || a.getUTCSeconds() > 0 || b.getUTCSeconds() > 0;
  const now = new Date(nowMs);
  const yr =
    a.getUTCFullYear() !== now.getUTCFullYear() ||
    b.getUTCFullYear() !== now.getUTCFullYear();
  const dpart = (d: Date) =>
    `${yr ? `${d.getUTCFullYear()}-` : ""}${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const tpart = (d: Date) =>
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` +
    (needS ? `:${pad(d.getUTCSeconds())}` : "") +
    (needMs ? `.${pad(d.getUTCMilliseconds(), 3)}` : "");
  const sameDay = utcDayStart(fromMs) === utcDayStart(toMs);
  return `${dpart(a)} ${tpart(a)} → ${sameDay ? "" : `${dpart(b)} `}${tpart(b)} · ${formatSpanShort(span)}`;
}

export function rangeTriggerLabel(
  range: RangeMode,
  from: string,
  to: string,
  nowMs = Date.now(),
): string {
  if (range === "custom") {
    const start = Date.parse(from);
    const end = Date.parse(to);
    return formatCustomRangeLabel(
      Number.isNaN(start) ? nowMs : start,
      Number.isNaN(end) ? nowMs : end,
      nowMs,
    );
  }
  return `Last ${range}`;
}

export function absStampUtc(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
}

export function absApplyPreview(fromMs: number, toMs: number): string {
  if (!absWindowOk(fromMs, toMs)) {
    return "To must be after From.";
  }
  const toLabel =
    utcDayStart(fromMs) === utcDayStart(toMs)
      ? absStampUtc(toMs).slice(11)
      : absStampUtc(toMs);
  return `Applies ${absStampUtc(fromMs)} → ${toLabel} · ${formatSpanShort(toMs - fromMs)}`;
}

/** Pin a From/To edit to a legal custom window (1ms…365d). */
export function commitAbsLocal(
  field: AbsField,
  nextLocal: string,
  currentFrom: string,
  currentTo: string,
): { from: string; to: string } | null {
  const nextFrom = field === "from" ? nextLocal : currentFrom;
  const nextTo = field === "to" ? nextLocal : currentTo;
  const clamped = clampAbsWindow(Date.parse(nextFrom), Date.parse(nextTo), field);
  if (!clamped) {
    return null;
  }
  return {
    from: toLocalInput(new Date(clamped.fromMs)),
    to: toLocalInput(new Date(clamped.toMs)),
  };
}

export function draftPartsForRange(
  range: RangeMode,
  from: string,
  to: string,
  live: boolean,
  liveWindowMs: number,
): { count: number; unit: RangeUnit } {
  if (range !== "custom") {
    return parseRangeParts(range) ?? { count: 1, unit: "h" };
  }
  const span = live ? liveWindowMs : rangeDurationMs(from, to);
  return partsFromMs(span);
}

export function formatSearchElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function scanningRangeLabel(range: RangeMode): string {
  return range === "custom" ? "custom" : range;
}

export function isValidRelativeDraft(count: number, unit: RangeUnit): boolean {
  return parseRangeMs(`${count}${unit}`) !== null;
}
