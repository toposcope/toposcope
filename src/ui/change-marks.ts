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

export { formatChangeMarkLabel };
