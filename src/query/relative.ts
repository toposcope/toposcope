const SECOND_MS = 1000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
/** Matches Settings retention clamp (1–365). Search does not invent a tighter cap. */
export const MAX_RETENTION_DAYS = 365;
export const MAX_RANGE_MS = MAX_RETENTION_DAYS * DAY_MS;

export function retentionRangeMs(days: number): number {
  if (!Number.isFinite(days)) {
    return 30 * DAY_MS;
  }
  const n = Math.min(MAX_RETENTION_DAYS, Math.max(1, Math.floor(days)));
  return n * DAY_MS;
}

/** Cap a custom `from`/`to` span at 365d (keep `to`, raise `from`). */
export function clampSearchSpan(
  from?: string,
  to?: string,
): { from?: string; to?: string } {
  if (!from || !to) {
    return { from, to };
  }
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return { from, to };
  }
  if (toMs - fromMs <= MAX_RANGE_MS) {
    return { from, to };
  }
  return { from: new Date(toMs - MAX_RANGE_MS).toISOString(), to };
}

export const rangePresets = ["15m", "1h", "4h", "24h", "7d"] as const;
export type RangePreset = (typeof rangePresets)[number];

export const rangeUnits = ["ms", "s", "m", "h", "d", "w"] as const;
export type RangeUnit = (typeof rangeUnits)[number];

export const rangeUnitTitles: Record<RangeUnit, string> = {
  ms: "milliseconds",
  s: "seconds",
  m: "minutes",
  h: "hours",
  d: "days",
  w: "weeks",
};

const unitMs: Record<RangeUnit, number> = {
  ms: 1,
  s: SECOND_MS,
  m: MINUTE_MS,
  h: HOUR_MS,
  d: DAY_MS,
  w: WEEK_MS,
};

/** `ms` before `m` so `1ms` is not `1m`. */
const rangeTokenRe = /^([1-9]\d*)(ms|s|m|h|d|w)$/;

export class InvalidRangeError extends Error {
  constructor(range: string) {
    super(`Invalid range: ${range}`);
    this.name = "InvalidRangeError";
  }
}

function parseRangeUnit(value: string | undefined): RangeUnit | null {
  if (!value || !(rangeUnits as readonly string[]).includes(value)) {
    return null;
  }
  return value as RangeUnit;
}

export function parseRangeMs(range: string): number | null {
  const match = rangeTokenRe.exec(range.trim());
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  const unit = parseRangeUnit(match[2]);
  if (unit === null || Number.isNaN(amount)) {
    return null;
  }
  const ms = amount * unitMs[unit];
  if (ms <= 0 || ms > MAX_RANGE_MS) {
    return null;
  }
  return ms;
}

export function isRelativeRange(value: string): boolean {
  return parseRangeMs(value) !== null;
}

export function parseRangeParts(range: string): { count: number; unit: RangeUnit } | null {
  const match = rangeTokenRe.exec(range.trim());
  if (!match || parseRangeMs(range) === null) {
    return null;
  }
  const count = Number(match[1]);
  const unit = parseRangeUnit(match[2]);
  if (unit === null || Number.isNaN(count)) {
    return null;
  }
  return { count, unit };
}

export function formatRangeToken(count: number, unit: RangeUnit): string {
  return `${count}${unit}`;
}

export function rangeUnitStep(unit: RangeUnit): number {
  switch (unit) {
    case "m":
      return 5;
    case "ms":
    case "s":
    case "h":
    case "d":
    case "w":
      return 1;
    default: {
      const _exhaustive: never = unit;
      return _exhaustive;
    }
  }
}

export function stepRangeCount(count: number, unit: RangeUnit, dir: 1 | -1): number {
  return Math.min(999, Math.max(1, count + dir * rangeUnitStep(unit)));
}

export function partsFromMs(ms: number): { count: number; unit: RangeUnit } {
  if (ms >= DAY_MS && ms % DAY_MS === 0) {
    const days = ms / DAY_MS;
    if (days >= 1 && days <= 999) {
      return { count: days, unit: "d" };
    }
  }
  if (ms >= HOUR_MS && ms % HOUR_MS === 0) {
    const hours = ms / HOUR_MS;
    if (hours >= 1 && hours <= 999) {
      return { count: hours, unit: "h" };
    }
  }
  if (ms >= MINUTE_MS && ms % MINUTE_MS === 0) {
    const minutes = ms / MINUTE_MS;
    if (minutes >= 1 && minutes <= 999) {
      return { count: minutes, unit: "m" };
    }
  }
  if (ms >= SECOND_MS && ms % SECOND_MS === 0) {
    const seconds = ms / SECOND_MS;
    if (seconds >= 1 && seconds <= 999) {
      return { count: seconds, unit: "s" };
    }
  }
  if (ms >= 1 && ms <= 999) {
    return { count: Math.min(999, Math.max(1, Math.round(ms))), unit: "ms" };
  }
  if (ms < MINUTE_MS) {
    return {
      count: Math.min(999, Math.max(1, Math.round(ms / SECOND_MS))),
      unit: "s",
    };
  }
  return { count: Math.min(999, Math.max(1, Math.round(ms / MINUTE_MS))), unit: "m" };
}

export function resolveRange(
  range: string,
  now = Date.now(),
): { from: string; to: string } | null {
  const ms = parseRangeMs(range);
  if (ms === null) {
    return null;
  }
  return {
    from: new Date(now - ms).toISOString(),
    to: new Date(now).toISOString(),
  };
}
