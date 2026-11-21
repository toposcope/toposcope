import { formatChangeMarkLabel, type ChangeMark, type ChangeMarkKind } from "../shared/change-mark";
import { formatDuration } from "../shared/duration";

export const changeMarkClusterFrac = 0.016;
export const changeMarkPeekCrowdFrac = 0.08;
export const changeMarkLabelGapFrac = 0.12;

const railChipGapPx = 2;

export type MarkCluster = {
  members: ChangeMark[];
  fromMs: number;
  toMs: number;
};

export function visibleChangeMarks(
  marks: ChangeMark[],
  offKinds: readonly ChangeMarkKind[],
  mutedIds: readonly string[],
): ChangeMark[] {
  const off = new Set(offKinds);
  const muted = new Set(mutedIds);
  return marks.filter((mark) => !off.has(mark.kind) && !muted.has(mark.id));
}

export function clusterChangeMarks(
  marks: ChangeMark[],
  spanMs: number,
  minFrac = changeMarkClusterFrac,
): MarkCluster[] {
  const minMs = Math.max(1, spanMs * minFrac);
  const sorted = [...marks].sort(
    (a, b) => Date.parse(a.ts) - Date.parse(b.ts),
  );
  const clusters: MarkCluster[] = [];
  for (const mark of sorted) {
    const t = Date.parse(mark.ts);
    const last = clusters[clusters.length - 1];
    if (last && t - last.toMs < minMs) {
      last.members.push(mark);
      last.toMs = t;
      continue;
    }
    clusters.push({ members: [mark], fromMs: t, toMs: t });
  }
  return clusters;
}

/**
 * Clusters as a rail `railW` px wide can draw them: a chip that would touch the one before it folds
 * into it as one count, and the next is measured against that fold. `frac` places a time on the rail.
 */
export function foldClustersForRail(
  clusters: readonly MarkCluster[],
  frac: (ms: number) => number,
  railW: number,
  widths: { lone: number; fold: number },
): MarkCluster[] {
  if (railW <= 0) {
    return [...clusters];
  }
  const width = (c: MarkCluster) => (c.members.length === 1 ? widths.lone : widths.fold);
  const centre = (c: MarkCluster) => frac((c.fromMs + c.toMs) / 2) * railW;
  const out: MarkCluster[] = [];
  for (const cluster of clusters) {
    const prev = out.at(-1);
    if (prev && centre(cluster) - centre(prev) < (width(prev) + width(cluster)) / 2 + railChipGapPx) {
      out[out.length - 1] = { members: [...prev.members, ...cluster.members], fromMs: prev.fromMs, toMs: cluster.toMs };
    } else {
      out.push(cluster);
    }
  }
  return out;
}

export function clusterKinds(cluster: MarkCluster): ChangeMarkKind[] {
  const seen = new Set<ChangeMarkKind>();
  const kinds: ChangeMarkKind[] = [];
  for (const mark of cluster.members) {
    if (!seen.has(mark.kind)) {
      seen.add(mark.kind);
      kinds.push(mark.kind);
    }
  }
  return kinds;
}

export function newestFirst(marks: ChangeMark[]): ChangeMark[] {
  return [...marks].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
}

export function marksInBucket(
  marks: ChangeMark[],
  bucketMs: number,
  stepMs: number,
): ChangeMark[] {
  const end = bucketMs + stepMs;
  return newestFirst(
    marks.filter((mark) => {
      const t = Date.parse(mark.ts);
      return t >= bucketMs && t < end;
    }),
  );
}

export function clusterHasLaneLabel(
  cluster: MarkCluster,
  clusters: MarkCluster[],
  spanMs: number,
): boolean {
  if (cluster.members.length !== 1 || spanMs <= 0) {
    return false;
  }
  const t = cluster.fromMs;
  return !clusters.some(
    (other) =>
      other !== cluster &&
      Math.abs(other.fromMs - t) / spanMs < changeMarkLabelGapFrac,
  );
}

const peekNamedPx = 190;
/** Where a peek folded to its arrow and glyph ends, from its edge of the lane. */
const peekFoldedPx = 36;
const chipGapPx = 2;

/**
 * How far each chip on a rail moves to clear a peek at its edge, in px, given each chip's centre
 * `at` and width `w`, in rail order. A chip it pushes pushes the next one; the rest stay on their time.
 */
export function chipsClearOfPeeks(chips: readonly { at: number; w: number }[], railW: number, peeks: { left: boolean; right: boolean }): number[] {
  const shifts = chips.map(() => 0);
  if (railW <= 0) {
    return shifts;
  }
  if (peeks.left) {
    let edge = peekFoldedPx;
    for (let i = 0; i < chips.length; i++) {
      const start = chips[i]!.at - chips[i]!.w / 2;
      if (start >= edge) {
        break;
      }
      shifts[i] = edge - start;
      edge += chips[i]!.w + chipGapPx;
    }
  }
  if (peeks.right) {
    let edge = railW - peekFoldedPx;
    for (let i = chips.length - 1; i >= 0; i--) {
      const end = chips[i]!.at + chips[i]!.w / 2;
      if (end <= edge) {
        break;
      }
      shifts[i] = edge - end;
      edge -= chips[i]!.w + chipGapPx;
    }
  }
  return shifts;
}

export function peekCrowded(
  side: "left" | "right",
  clusters: MarkCluster[],
  fromMs: number,
  spanMs: number,
  laneW = 0,
): boolean {
  if (spanMs <= 0) {
    return false;
  }
  const edge = side === "left" ? fromMs : fromMs + spanMs;
  // A named peek is about 150px wide, with half a chip beside it: on a narrow rail 8% is less.
  const threshold = Math.max(spanMs * changeMarkPeekCrowdFrac, laneW > 0 ? (spanMs * peekNamedPx) / laneW : 0);
  return clusters.some((cluster) => {
    const t = side === "left" ? cluster.fromMs : cluster.toMs;
    return Math.abs(t - edge) < threshold;
  });
}

export function panWindowToMark(
  fromMs: number,
  toMs: number,
  markMs: number,
): { fromMs: number; toMs: number } {
  const span = toMs - fromMs;
  if (!Number.isFinite(span) || span <= 0) {
    return { fromMs, toMs };
  }
  if (markMs >= fromMs && markMs <= toMs) {
    return { fromMs, toMs };
  }
  if (markMs < fromMs) {
    return { fromMs: markMs, toMs: markMs + span };
  }
  return { fromMs: markMs - span, toMs: markMs };
}

export function markPlotSpanMs(
  binCount: number,
  stepMs: number,
  clockSpanMs: number,
): number {
  if (binCount > 0 && stepMs > 0) {
    return binCount * stepMs;
  }
  return clockSpanMs;
}

export function markFrac(tsMs: number, fromMs: number, spanMs: number): number {
  if (spanMs <= 0) {
    return 0;
  }
  return (tsMs - fromMs) / spanMs;
}

export function markSource(mark: ChangeMark): string | null {
  const raw = mark.attrs.source?.trim();
  return raw && raw.length > 0 ? raw : null;
}

export function incidentEndLabel(mark: ChangeMark): string {
  const end = mark.end_ts ? Date.parse(mark.end_ts) : NaN;
  const start = Date.parse(mark.ts);
  const span =
    Number.isFinite(end) && Number.isFinite(start) ? end - start : 0;
  return `${mark.title} ends · ${formatDuration(span, "long", { round: true })}`;
}

/**
 * A mark's name on a lane chip (50i), short: its title, a deploy's service before it unless the
 * title already names it, and "a → b" as just b ("Toposcope 0.15.5 → 0.15.6" is "Toposcope 0.15.6").
 */
export function markLaneName(mark: Pick<ChangeMark, "kind" | "service" | "title">): string {
  const title = mark.title.trim().replace(/\S+\s*→\s*(\S+)/, "$1");
  const service = mark.service.trim();
  if (mark.kind === "deploy" && service && !title.toLowerCase().includes(service.toLowerCase())) {
    return `${service} ${title}`.trim();
  }
  return title || formatChangeMarkLabel(mark);
}

export function foldMarkLabel(members: ChangeMark[]): string {
  const ordered = newestFirst(members);
  const newest = ordered[0]?.ts.slice(11, 16) ?? "";
  const oldest = ordered[ordered.length - 1]?.ts.slice(11, 16) ?? "";
  return `${members.length} marks · ${oldest} – ${newest}`;
}

export type EventTableMarkRow =
  | { type: "event"; index: number; wash: boolean }
  | { type: "seam"; mark: ChangeMark }
  | { type: "end"; mark: ChangeMark }
  | { type: "fold"; members: ChangeMark[] }
  /** A short source's read position (#139): its rows after this are not here yet. */
  | { type: "held"; key: string; text: string }
  /** A monitor on this search opened here (#175, 18o). */
  | { type: "monitor"; key: string; at: number; name: string; detail: string };

/** Where monitors on this search opened, to place by time among the rows. */
export type MonitorRowIn = { at: number; key: string; name: string; detail: string };

/** Hatched rows to place by time: one per short source, at its read position. */
export type HeldRowsIn = {
  rows: ReadonlyArray<{ at: number; text: string; key: string }>;
  /** Every row of the window is loaded, so a position older than the last row still sits below it. */
  complete: boolean;
};

export type EventTableMarkLayout = {
  rows: EventTableMarkRow[];
  above: ChangeMark[];
  below: ChangeMark[];
};

function gapBeforeEvent(
  events: readonly { ts: string }[],
  tsMs: number,
): number {
  for (let i = 0; i < events.length; i++) {
    if (Date.parse(events[i]!.ts) <= tsMs) {
      return i;
    }
  }
  return events.length;
}

export function eventInIncidentWash(
  ts: string,
  marks: readonly ChangeMark[],
): boolean {
  const t = Date.parse(ts);
  if (Number.isNaN(t)) {
    return false;
  }
  return marks.some((mark) => {
    if (mark.kind !== "incident" || !mark.end_ts) {
      return false;
    }
    const start = Date.parse(mark.ts);
    const end = Date.parse(mark.end_ts);
    return t >= start && t <= end;
  });
}

export function eventTableMarkLayout(
  events: readonly { ts: string }[],
  marks: readonly ChangeMark[],
  pinId?: string | null,
  held?: HeldRowsIn,
  opened: readonly MonitorRowIn[] = [],
): EventTableMarkLayout {
  if (events.length === 0) {
    return { rows: [], above: [], below: [] };
  }
  const openedAt = new Map<number, MonitorRowIn[]>();
  for (const row of opened) {
    const gap = gapBeforeEvent(events, row.at);
    // Older than the page: it shows when the page reaches it.
    if (gap === events.length && !held?.complete) {
      continue;
    }
    openedAt.set(gap, [...(openedAt.get(gap) ?? []), row].sort((a, b) => b.at - a.at));
  }
  const heldAt = new Map<number, Array<{ at: number; text: string; key: string }>>();
  for (const row of held?.rows ?? []) {
    const gap = gapBeforeEvent(events, row.at);
    if (gap === events.length && !held?.complete) {
      continue;
    }
    heldAt.set(gap, [...(heldAt.get(gap) ?? []), row].sort((a, b) => b.at - a.at));
  }
  const gaps = new Map<number, ChangeMark[]>();
  const ends = new Map<number, ChangeMark[]>();
  const above: ChangeMark[] = [];
  const below: ChangeMark[] = [];
  const last = events.length;
  const newestMs = Date.parse(events[0]!.ts);
  for (const mark of marks) {
    const startMs = Date.parse(mark.ts);
    if (Number.isNaN(startMs)) {
      continue;
    }
    const startGap = gapBeforeEvent(events, startMs);
    if (startGap === last) {
      below.push(mark);
    } else if (startGap === 0 && startMs > newestMs && mark.id !== pinId) {
      // Newest-from-`to` never hits this. Focus in logs does: the page is a
      // middle slice, and a later in-window mark is not adjacent to row 0.
      above.push(mark);
    } else {
      const bucket = gaps.get(startGap) ?? [];
      bucket.push(mark);
      gaps.set(startGap, bucket);
    }
    if (mark.kind !== "incident" || !mark.end_ts) {
      continue;
    }
    const endMs = Date.parse(mark.end_ts);
    if (Number.isNaN(endMs)) {
      continue;
    }
    const endGap = gapBeforeEvent(events, endMs);
    if (endGap === last || (endGap === 0 && endMs > newestMs)) {
      continue;
    }
    const bucket = ends.get(endGap) ?? [];
    bucket.push(mark);
    ends.set(endGap, bucket);
  }
  const rows: EventTableMarkRow[] = [];
  for (let i = 0; i < events.length; i++) {
    for (const row of heldAt.get(i) ?? []) {
      rows.push({ type: "held", key: row.key, text: row.text });
    }
    for (const row of openedAt.get(i) ?? []) {
      rows.push({ type: "monitor", ...row });
    }
    const gapMarks = newestFirst(gaps.get(i) ?? []);
    const gapEnds = newestFirst(ends.get(i) ?? []);
    for (const mark of gapEnds) {
      rows.push({ type: "end", mark });
    }
    if (gapMarks.length >= 3) {
      rows.push({ type: "fold", members: gapMarks });
    } else {
      for (const mark of gapMarks) {
        rows.push({ type: "seam", mark });
      }
    }
    rows.push({
      type: "event",
      index: i,
      wash: eventInIncidentWash(events[i]!.ts, marks),
    });
  }
  for (const row of heldAt.get(events.length) ?? []) {
    rows.push({ type: "held", key: row.key, text: row.text });
  }
  for (const row of openedAt.get(events.length) ?? []) {
    rows.push({ type: "monitor", ...row });
  }
  return { rows, above: newestFirst(above), below: newestFirst(below) };
}

export { formatChangeMarkLabel };
