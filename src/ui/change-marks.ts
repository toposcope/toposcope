import {
  formatChangeMarkLabel,
  type ChangeMark,
  type ChangeMarkKind,
} from "../shared/change-mark";

export const changeMarkClusterFrac = 0.016;
export const changeMarkPeekCrowdFrac = 0.08;
export const changeMarkLabelGapFrac = 0.12;

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

export function peekCrowded(
  side: "left" | "right",
  clusters: MarkCluster[],
  fromMs: number,
  spanMs: number,
): boolean {
  if (spanMs <= 0) {
    return false;
  }
  const edge = side === "left" ? fromMs : fromMs + spanMs;
  const threshold = spanMs * changeMarkPeekCrowdFrac;
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

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export function formatMarkDuration(ms: number): string {
  const n = Math.max(0, Math.round(ms));
  if (n < 1000) {
    return `${Math.max(1, n)}ms`;
  }
  if (n < MINUTE_MS) {
    return `${Math.round(n / 1000)}s`;
  }
  if (n < HOUR_MS) {
    return `${Math.round(n / MINUTE_MS)}m`;
  }
  const hours = Math.floor(n / HOUR_MS);
  const minutes = Math.round((n - hours * HOUR_MS) / MINUTE_MS);
  if (minutes === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${minutes}m`;
}

export function incidentEndLabel(mark: ChangeMark): string {
  const end = mark.end_ts ? Date.parse(mark.end_ts) : NaN;
  const start = Date.parse(mark.ts);
  const span =
    Number.isFinite(end) && Number.isFinite(start) ? end - start : 0;
  return `${mark.title} ends · ${formatMarkDuration(span)}`;
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
  | { type: "fold"; members: ChangeMark[] };

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
): EventTableMarkLayout {
  if (events.length === 0) {
    return { rows: [], above: [], below: [] };
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
  return { rows, above: newestFirst(above), below: newestFirst(below) };
}

export { formatChangeMarkLabel };
