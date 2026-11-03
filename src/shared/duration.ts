/**
 * One duration formatter (sheet 45, Numbers, time and words). Three styles:
 * - `short`, one unit: a window or a bar (`15m`, `1d`, `90s` with `whole`), a Live age (`least: "s"`).
 * - `long`, up to two units: how long something was open (`7h 59m`, `3d 4h`), a run (`3m 12s`),
 *   a mark (`1h 2m`) or a cut (`11h 20m`, `1m 29s`).
 * - `precise`, a decimal: search elapsed (`1.2s`) or a span (`32.4ms`).
 * Each place reads as it did before this formatter; the options say how.
 */
export type DurationStyle = "short" | "long" | "precise";

export type DurationOptions = {
  /** short: the largest unit that divides it exactly (`90s`, `1d`), `0` at none: a setting or a bar. */
  whole?: boolean;
  /** short: never under a second (`1s`): a Live age. */
  least?: "ms" | "s";
  /** long: to the nearest second or minute, not down: a run, a mark, a cut. */
  round?: boolean;
  /** long: minutes carry their seconds (`3m 12s`): a run, a cut. */
  seconds?: boolean;
  /** long: days only when whole (`2d`), else hours and minutes: a cut. */
  days?: "exact";
  /** precise: in milliseconds (`32.4ms`) rather than seconds (`1.2s`). */
  unit?: "s" | "ms";
};

const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;

export function formatDuration(ms: number, style: DurationStyle, opts: DurationOptions = {}): string {
  switch (style) {
    case "short":
      return opts.whole ? whole(ms) : opts.least === "s" ? age(ms) : short(ms);
    case "long":
      if (opts.round && opts.seconds) {
        return opts.days === "exact" ? cut(ms) : run(ms);
      }
      return opts.round ? mark(ms) : openFor(ms);
    case "precise":
      return opts.unit === "ms" ? `${ms >= 100 ? Math.round(ms) : Math.round(ms * 10) / 10}ms` : `${(ms / S).toFixed(1)}s`;
    default: {
      const _exhaustive: never = style;
      return _exhaustive;
    }
  }
}

/** A window or a bar: whole days and hours first, then the nearest hour, minute or second. */
function short(ms: number): string {
  if (ms >= D && ms % D === 0) {
    return `${ms / D}d`;
  }
  if (ms >= H && ms % H === 0) {
    return `${ms / H}h`;
  }
  if (ms >= H) {
    return `${Math.round(ms / H)}h`;
  }
  if (ms >= M) {
    return `${Math.round(ms / M)}m`;
  }
  if (ms >= S) {
    return `${Math.round(ms / S)}s`;
  }
  return `${Math.max(1, Math.round(ms))}ms`;
}

/** A Live age: from 1s, in the nearest second, minute or hour. */
function age(ms: number): string {
  const sec = Math.max(1, Math.round(ms / S));
  if (sec < 60) {
    return `${sec}s`;
  }
  const min = Math.round(sec / 60);
  if (min < 60) {
    return `${min}m`;
  }
  return `${Math.round(min / 60)}h`;
}

/** A setting or a bar width: its largest whole unit, days at most (`1d`, `15m`, `90s`, `0`). */
function whole(ms: number): string {
  if (ms <= 0) {
    return "0";
  }
  for (const [unit, size] of [["d", D], ["h", H], ["m", M], ["s", S]] as const) {
    if (ms % size === 0) {
      return `${ms / size}${unit}`;
    }
  }
  return `${ms}ms`;
}

/** How long a stretch has been open, or lasted: whole units, days past 48h. */
function openFor(ms: number): string {
  const s = Math.max(0, Math.floor(ms / S));
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m`;
  }
  const h = Math.floor(m / 60);
  if (h < 48) {
    const rest = m % 60;
    return rest > 0 ? `${h}h ${rest}m` : `${h}h`;
  }
  const d = Math.floor(h / 24);
  const rest = h % 24;
  return rest > 0 ? `${d}d ${rest}h` : `${d}d`;
}

/** How long a run took: seconds under a minute, minutes and seconds under an hour. */
function run(ms: number): string {
  const s = Math.max(0, Math.round(ms / S));
  if (s < 60) {
    return `${s}s`;
  }
  if (s < 3600) {
    const rest = s % 60;
    return rest > 0 ? `${Math.floor(s / 60)}m ${rest}s` : `${Math.floor(s / 60)}m`;
  }
  return openFor(ms);
}

/** A mark's length: the nearest unit under an hour, then hours and minutes. */
function mark(ms: number): string {
  const n = Math.max(0, Math.round(ms));
  if (n < S) {
    return `${Math.max(1, n)}ms`;
  }
  if (n < M) {
    return `${Math.round(n / S)}s`;
  }
  if (n < H) {
    return `${Math.round(n / M)}m`;
  }
  const hours = Math.floor(n / H);
  const minutes = Math.round((n - hours * H) / M);
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** A cut's side: whole days, else hours and minutes, minutes and seconds, seconds or ms. */
function cut(ms: number): string {
  const abs = Math.max(0, Math.round(ms));
  if (abs >= D && abs % D === 0) {
    return `${abs / D}d`;
  }
  if (abs >= H) {
    const h = Math.floor(abs / H);
    const m = Math.round((abs % H) / M);
    if (m === 0) {
      return `${h}h`;
    }
    return m === 60 ? `${h + 1}h` : `${h}h ${m}m`;
  }
  if (abs >= M) {
    const m = Math.floor(abs / M);
    const s = Math.round((abs % M) / S);
    if (s === 0) {
      return `${m}m`;
    }
    return `${m}m ${s}s`;
  }
  if (abs >= S) {
    return `${Math.max(1, Math.round(abs / S))}s`;
  }
  return `${Math.max(1, abs)}ms`;
}
