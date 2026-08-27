import { levelHex } from "./histogram-series";
import type { LogEvent } from "./types";

export type TapeTick = {
  key: string;
  leftPct: number;
  height: number;
  width: number;
  color: string;
};

export function surroundingTape(
  rows: LogEvent[],
  anchor: { ts: string; service?: string },
): { ticks: TapeTick[]; from: string; to: string; label: string } {
  if (rows.length === 0) {
    return { ticks: [], from: "", to: "", label: "0 rows" };
  }
  const t0 = Date.parse(rows[0]!.ts);
  const t1 = Date.parse(rows[rows.length - 1]!.ts);
  const span = Math.max(1, t1 - t0);
  const secs = Math.round(span / 1000);
  const ticks = rows.map((event) => {
    const on =
      event.ts === anchor.ts &&
      (anchor.service == null || event.service === anchor.service);
    const err = event.level === "error" || event.level === "fatal";
    return {
      key: `${event.ts}|${event.service}|${event.host ?? ""}`,
      leftPct: ((Date.parse(event.ts) - t0) / span) * 100,
      width: on ? 2 : 1,
      height: on ? 24 : err ? 15 : event.level === "warn" ? 12 : 8,
      color: on
        ? "oklch(0.985 0 0)"
        : err
          ? levelHex[event.level]
          : event.level === "warn"
            ? levelHex.warn
            : "oklch(1 0 0 / 30%)",
    };
  });
  return {
    ticks,
    from: rows[0]!.ts.slice(11, 19),
    to: rows[rows.length - 1]!.ts.slice(11, 19),
    label: `${rows.length} rows · ${secs >= 90 ? `${Math.round(secs / 60)}m` : `${secs}s`}`,
  };
}

export function frozenQueryNote(mode: "all" | "match", q: string): string {
  const query = q.trim();
  if (mode === "all") {
    return query
      ? `Frozen query · ${query} — matching rows are marked, nothing is filtered out`
      : "Everything this service logged around the event";
  }
  return query
    ? `Frozen query · showing only rows matching ${query}`
    : "No query on the tab this was opened from — nothing to narrow to";
}

export function markFocusNote(q: string, n: number): string {
  const query = q.trim();
  return query
    ? `Frozen query · ${query} — ${n} before and ${n} after this mark, nothing is filtered out`
    : `${n} logs before this mark and ${n} after, in the hunt window`;
}
