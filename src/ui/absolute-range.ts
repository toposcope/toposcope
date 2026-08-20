import { MAX_RANGE_MS } from "../query/relative";

export type AbsField = "from" | "to";

export const UTC_DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export const UTC_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export function utcDayStart(ms: number): number {
  return Math.floor(ms / UTC_DAY_MS) * UTC_DAY_MS;
}

export function utcTimeOfDay(ms: number): number {
  return ms - utcDayStart(ms);
}

export function clampAbsWindow(
  fromMs: number,
  toMs: number,
  prefer: AbsField,
): { fromMs: number; toMs: number } | null {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return null;
  }
  let from = fromMs;
  let to = toMs;
  if (to <= from) {
    if (prefer === "from") {
      to = from + 1;
    } else {
      from = to - 1;
    }
  }
  if (to - from > MAX_RANGE_MS) {
    if (prefer === "from") {
      to = from + MAX_RANGE_MS;
    } else {
      from = to - MAX_RANGE_MS;
    }
  }
  if (to - from < 1) {
    return null;
  }
  return { fromMs: from, toMs: to };
}

export function utcMonthStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export function shiftUtcMonth(monthStartMs: number, delta: number): number {
  const d = new Date(monthStartMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, 1);
}

export function applyAbsDay(
  pick: AbsField,
  dayMs: number,
  fromMs: number,
  toMs: number,
): { fromMs: number; toMs: number; pick: AbsField } | null {
  if (pick === "from") {
    const nextFrom = dayMs + utcTimeOfDay(fromMs);
    const nextTo = toMs > nextFrom ? toMs : nextFrom + HOUR_MS;
    const clamped = clampAbsWindow(nextFrom, nextTo, "from");
    return clamped ? { ...clamped, pick: "from" } : null;
  }
  const nextTo = dayMs + utcTimeOfDay(toMs);
  if (nextTo <= fromMs) {
    const nextFrom = dayMs + utcTimeOfDay(fromMs);
    const clamped = clampAbsWindow(nextFrom, toMs, "from");
    return clamped ? { ...clamped, pick: "from" } : null;
  }
  const clamped = clampAbsWindow(fromMs, nextTo, "to");
  return clamped ? { ...clamped, pick: "to" } : null;
}

export function applyAbsClock(
  pick: AbsField,
  fromMs: number,
  toMs: number,
  hours: number,
  minutes: number,
  seconds: number,
  millis: number,
): { fromMs: number; toMs: number } | null {
  const act = pick === "to" ? toMs : fromMs;
  const next =
    utcDayStart(act) +
    hours * 3_600_000 +
    minutes * 60_000 +
    seconds * 1000 +
    millis;
  return clampAbsWindow(
    pick === "from" ? next : fromMs,
    pick === "to" ? next : toMs,
    pick,
  );
}

export function absWindowOk(fromMs: number, toMs: number): boolean {
  const span = toMs - fromMs;
  return Number.isFinite(span) && span > 0 && span <= MAX_RANGE_MS;
}

export type RangeApply =
  | { kind: "abs"; fromMs: number; toMs: number }
  | { kind: "rel"; token: string };

/** Apply writes the section that was actually edited. Absolute draft wins if touched. */
export function resolveRangeApply(
  absTouched: boolean,
  fromMs: number,
  toMs: number,
  relativeToken: string,
  relativeOk: boolean,
): RangeApply | null {
  if (absTouched) {
    return absWindowOk(fromMs, toMs) ? { kind: "abs", fromMs, toMs } : null;
  }
  return relativeOk ? { kind: "rel", token: relativeToken } : null;
}
