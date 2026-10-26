import type { ChangeMark, ChangeMarkKind } from "../shared/change-mark";

/** Pure pieces of the marks panel (#262, frame 26f). */

export const dayMs = 24 * 60 * 60_000;

/** The start of the UTC day `nowMs` is in, `back` days earlier. */
export function utcDayStart(nowMs: number, back = 0): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - back * dayMs;
}

/** Newest first, with the kinds that are off left out. */
export function panelRows(marks: ChangeMark[], off: ChangeMarkKind[]): ChangeMark[] {
  return marks.filter((m) => !off.includes(m.kind)).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
}

/** "ci · sha 4f9c1e", "pagerduty", "here": where a mark came from, in a word or two. */
export function markFrom(mark: ChangeMark): string {
  const source = mark.attrs.source?.trim();
  const sha = mark.attrs.sha?.trim() || mark.attrs.commit?.trim();
  if (source && sha) {
    return `${source} · sha ${sha.slice(0, 6)}`;
  }
  if (source) {
    return source;
  }
  if (sha) {
    return `sha ${sha.slice(0, 6)}`;
  }
  return mark.kind === "note" ? "here" : "";
}

/** The selected mark's attrs in one mono line: "version=v0.9 · service=billing · by github-actions". */
export function attrLine(mark: ChangeMark): string {
  const parts = Object.entries(mark.attrs)
    .filter(([k]) => k !== "source" && k !== "sha" && k !== "commit" && k !== "by")
    .map(([k, v]) => `${k}=${v}`);
  if (mark.service) {
    parts.push(`service=${mark.service}`);
  }
  if (mark.attrs.by) {
    parts.push(`by ${mark.attrs.by}`);
  }
  return parts.join(" · ");
}

/** How many of `marks` sit inside the hunt's window. */
export function inWindow(marks: ChangeMark[], fromMs: number, toMs: number): number {
  return marks.filter((m) => {
    const t = Date.parse(m.ts);
    return t >= fromMs && t <= toMs;
  }).length;
}
