import { histogramIntervalMs, histogramIntervalMsById, parseHistogramInterval, type HistogramIntervalId } from "../query/histogram";
import { resolveFilters, type SearchFilters } from "../query/index";

/**
 * A share's limits (#226): a scope alone still lets a holder pull a fine-grained copy of everything
 * in it, a few hundred bars at a time. Every share has all four.
 */
export type ShareLimits = {
  /** The finest bar a read gets. Auto snaps up to it; an explicit finer `step=` is refused. */
  min_step: HistogramIntervalId;
  /** The longest window one read covers. */
  max_range: string;
  /** How far before now a window may start: without it, a week at a time walks all of history. */
  max_lookback: string;
  reads_per_minute: number;
};

export const defaultShareLimits: ShareLimits = {
  min_step: "1m",
  max_range: "7d",
  max_lookback: "30d",
  reads_per_minute: 120,
};

const unitMs: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
const maxRangeMs = 365 * unitMs.d!;
/** Metrics may keep 730 days (#215), so a share may reach that far back. */
const maxLookbackMs = 730 * unitMs.d!;
const maxReadsPerMinute = 6000;

/** `30d`, `12h`, `2w`: whole minutes, hours, days or weeks. */
export function durationMs(raw: string): number | null {
  const match = /^(\d{1,6})([mhdw])$/.exec(raw.trim());
  if (!match) {
    return null;
  }
  const ms = Number(match[1]) * unitMs[match[2]!]!;
  return ms > 0 ? ms : null;
}

/** Limits from the operator API; a field left out takes its default. */
export function parseShareLimits(raw: unknown, base: ShareLimits = defaultShareLimits): ShareLimits | { error: string } {
  if (raw === undefined || raw === null) {
    return base;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "limits is an object" };
  }
  const rec = raw as Record<string, unknown>;
  const out = { ...base };
  if (rec.min_step !== undefined) {
    const step = typeof rec.min_step === "string" ? parseHistogramInterval(rec.min_step.trim()) : undefined;
    if (!step) {
      return { error: "limits.min_step is a bar width: 1ms … 7d, as step= takes it" };
    }
    out.min_step = step;
  }
  if (rec.max_range !== undefined) {
    const ms = typeof rec.max_range === "string" ? durationMs(rec.max_range) : null;
    if (ms === null || ms > maxRangeMs) {
      return { error: "limits.max_range is a duration up to 365d (30d, 12h, 2w)" };
    }
    out.max_range = (rec.max_range as string).trim();
  }
  if (rec.max_lookback !== undefined) {
    const ms = typeof rec.max_lookback === "string" ? durationMs(rec.max_lookback) : null;
    if (ms === null || ms > maxLookbackMs) {
      return { error: "limits.max_lookback is a duration up to 730d" };
    }
    out.max_lookback = (rec.max_lookback as string).trim();
  }
  if (rec.reads_per_minute !== undefined) {
    const n = rec.reads_per_minute;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > maxReadsPerMinute) {
      return { error: `limits.reads_per_minute is a whole number, 1–${maxReadsPerMinute}` };
    }
    out.reads_per_minute = n;
  }
  if (histogramIntervalMsById[out.min_step] > durationMs(out.max_range)!) {
    return { error: "limits.min_step is wider than limits.max_range" };
  }
  return out;
}

/**
 * A read's window and bar width inside the limits, or why not. Auto snaps up to the finest bar;
 * an explicit finer `step=` is refused, so a caller always knows which number it got.
 */
export function windowWithin(
  limits: ShareLimits,
  window: Pick<SearchFilters, "from" | "to" | "range" | "step">,
  now = Date.now(),
): Pick<SearchFilters, "from" | "to" | "step"> | { error: string } {
  const resolved = resolveFilters({ ...window }, now);
  const fromMs = resolved.from ? Date.parse(resolved.from) : Number.NaN;
  const toMs = resolved.to ? Date.parse(resolved.to) : now;
  if (!Number.isFinite(fromMs)) {
    return { error: "a share reads a window: range=, or from and to" };
  }
  if (toMs - fromMs > durationMs(limits.max_range)!) {
    return { error: `this share's longest window is ${limits.max_range}` };
  }
  if (fromMs < now - durationMs(limits.max_lookback)!) {
    return { error: `this share reaches back ${limits.max_lookback}` };
  }
  const floorMs = histogramIntervalMsById[limits.min_step];
  const asked = window.step?.trim() || undefined;
  if (asked) {
    const id = parseHistogramInterval(asked);
    if (!id) {
      return { error: `step=${asked} is not a bar width` };
    }
    if (histogramIntervalMsById[id] < floorMs) {
      return { error: `this share's finest bar is ${limits.min_step}; step=${asked} is finer` };
    }
  }
  const step = histogramIntervalMs(resolved.from, resolved.to, asked) < floorMs ? limits.min_step : asked;
  return { from: resolved.from, to: resolved.to, ...(step ? { step } : {}) };
}
