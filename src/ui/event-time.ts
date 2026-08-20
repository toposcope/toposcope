import { useSyncExternalStore } from "react";
import { histogramWindowNeedsDate } from "./fill-histogram";

export const timestampFormats = ["compact", "full"] as const;
export type TimestampFormat = (typeof timestampFormats)[number];

const storageKey = "toposcope.timestampFormat";
const listeners = new Set<() => void>();

function isTimestampFormat(value: string | null): value is TimestampFormat {
  return value === "compact" || value === "full";
}

export function readTimestampFormat(): TimestampFormat {
  try {
    const raw = localStorage.getItem(storageKey);
    if (isTimestampFormat(raw)) {
      return raw;
    }
  } catch {
    // private mode / SSR
  }
  return "compact";
}

export function setTimestampFormat(value: TimestampFormat): void {
  try {
    localStorage.setItem(storageKey, value);
  } catch {
    // ignore quota / private mode
  }
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === storageKey) {
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useTimestampFormat(): TimestampFormat {
  return useSyncExternalStore(subscribe, readTimestampFormat, () => "compact");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

export type EventClockOpts = {
  format: TimestampFormat;
  fromMs: number;
  spanMs: number;
  nowMs?: number;
  precision?: "s" | "ms";
};

function fallbackClock(iso: string, precision: "s" | "ms"): string {
  if (precision === "ms") {
    return iso.length >= 23 ? iso.slice(11, 23) : iso;
  }
  return iso.length >= 19 ? iso.slice(11, 19) : iso;
}

/** Table / Surroundings / detail-head stamp. Compact follows the histogram date rule. */
export function formatEventClock(iso: string, opts: EventClockOpts): string {
  const precision = opts.precision ?? (opts.spanMs <= 1000 ? "ms" : "s");
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return fallbackClock(iso, precision);
  }
  const d = new Date(ms);
  const clock = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
  const frac = precision === "ms" ? `.${pad3(d.getUTCMilliseconds())}` : "";
  switch (opts.format) {
    case "full": {
      const ymd = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
      return `${ymd} ${clock}.${pad3(d.getUTCMilliseconds())}`;
    }
    case "compact": {
      const needsDate = histogramWindowNeedsDate(
        opts.fromMs,
        opts.spanMs,
        opts.nowMs ?? Date.now(),
      );
      if (!needsDate) {
        return `${clock}${frac}`;
      }
      const md = `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
      return `${md} ${clock}${frac}`;
    }
    default: {
      const _exhaustive: never = opts.format;
      return _exhaustive;
    }
  }
}

export function eventTableTimeTrack(
  format: TimestampFormat,
  needsDate: boolean,
): string {
  if (format === "full") {
    return "minmax(168px,220px)";
  }
  if (needsDate) {
    return "minmax(118px,168px)";
  }
  return "minmax(84px,148px)";
}

export function surroundingsTimeTrack(
  format: TimestampFormat,
  needsDate: boolean,
): string {
  if (format === "full") {
    return "168px";
  }
  if (needsDate) {
    return "118px";
  }
  return "78px";
}
