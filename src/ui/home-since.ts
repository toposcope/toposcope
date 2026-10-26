import type { ChangeMark, ChangeMarkKind } from "../shared/change-mark";

/** Pure pieces of Home (#259, frames 26a–26c). */

export const markGlyph: Record<ChangeMarkKind, { glyph: string; color: string }> = {
  deploy: { glyph: "▲", color: "#e7e1d3" },
  flag: { glyph: "⚑", color: "#2dd4bf" },
  incident: { glyph: "◆", color: "#ef4444" },
  note: { glyph: "○", color: "#8a8a93" },
};

export function hhmmUtc(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** "38 min ago", "2 h ago", "yesterday 16:02". */
export function markAge(iso: string, nowMs: number): string {
  const ms = nowMs - Date.parse(iso);
  const min = Math.round(ms / 60_000);
  if (min < 1) {
    return "just now";
  }
  if (min < 90) {
    return `${min} min ago`;
  }
  if (ms < 24 * 60 * 60_000) {
    return `${Math.round(ms / 3_600_000)} h ago`;
  }
  return `yesterday ${hhmmUtc(iso)}`;
}

/** "30 min before → 30 min after", "1 h before → 1 h after". */
export function sideText(sideMs: number): string {
  const min = Math.round(sideMs / 60_000);
  const one = min % 60 === 0 ? `${min / 60} h` : `${min} min`;
  return `${one} before → ${one} after`;
}

export function formatValue(v: number | null, kind: string): string {
  if (v === null) {
    return "—";
  }
  if (kind === "rate") {
    return `${(v * 100).toFixed(1)}%`;
  }
  const abs = Math.abs(v);
  if (Number.isInteger(v) && abs >= 10_000) {
    return v.toLocaleString("en-US").replace(/,/g, " ");
  }
  return Number.isInteger(v) ? String(v) : abs >= 100 ? v.toFixed(0) : v.toFixed(1);
}

/** The delta beside the after value: signed, "new" from 0, "±0" for no change, in red when up or grey. */
export function deltaText(before: number | null, after: number | null, kind: string): { text: string; up: boolean } {
  if (before === null || after === null) {
    return { text: "—", up: false };
  }
  if (before === 0 && after > 0) {
    return { text: "new", up: true };
  }
  const d = after - before;
  if (d === 0) {
    return { text: "±0", up: false };
  }
  const sign = d > 0 ? "+" : "−";
  const n = Math.abs(d);
  const text = kind === "rate" ? `${sign}${(n * 100).toFixed(1)}` : `${sign}${Number.isInteger(n) ? n : n.toFixed(1)}`;
  return { text, up: d > 0 };
}

/**
 * The mark the operator clicked is kept in this browser until a newer deploy or flag arrives:
 * `auto` is what the server would pick on its own now.
 */
export type HomePick = { markId: string; autoThen: string | null };

export function resolvePick(stored: HomePick | null, autoNow: string | null, marks: ChangeMark[]): string | null {
  if (!stored) {
    return null;
  }
  if (stored.autoThen !== autoNow) {
    return null;
  }
  return marks.some((m) => m.id === stored.markId) ? stored.markId : null;
}

/** The three first-run steps (26c): done when the instance is named, something arrived, a hunt and a mark exist. */
export function firstRunSteps(input: { named: boolean; ingested: boolean; savedCount: number; markCount: number }): boolean[] {
  return [input.named, input.ingested, input.savedCount > 0 && input.markCount > 0];
}
