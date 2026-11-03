import type { Span } from "../shared/span";
import { chartColor, chartError } from "./chart-palette";


export const TRACE_ERROR_HEX = chartError;

export type WaterfallRow = {
  span: Span;
  depth: number;
  startMs: number;
  selfMs: number;
};

export function intervalUnionMs(
  intervals: Array<{ start: number; duration: number }>,
): number {
  const segs = intervals
    .map((item) => [item.start, item.start + item.duration] as const)
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  if (segs[0] === undefined) {
    return 0;
  }
  let total = 0;
  let curStart = segs[0][0];
  let curEnd = segs[0][1];
  for (const [start, end] of segs.slice(1)) {
    if (start <= curEnd) {
      curEnd = Math.max(curEnd, end);
    } else {
      total += curEnd - curStart;
      curStart = start;
      curEnd = end;
    }
  }
  return total + Math.max(0, curEnd - curStart);
}

export function spanServiceColor(
  service: string,
  services: string[],
): string {
  return chartColor(services.indexOf(service));
}

export function flattenTrace(spans: Span[]): {
  rows: WaterfallRow[];
  baseMs: number;
  totalMs: number;
  missingParent: boolean;
  orphanCount: number;
} {
  const kids = new Map<string, Span[]>();
  const ids = new Set(spans.map((span) => span.span_id));
  const roots: Span[] = [];
  for (const span of spans) {
    const parent = span.parent_span_id;
    if (!parent || !ids.has(parent)) {
      roots.push(span);
      continue;
    }
    const list = kids.get(parent) ?? [];
    list.push(span);
    kids.set(parent, list);
  }
  const missingParent = roots.some((span) => span.parent_span_id.length > 0);
  const rootStart = (span: Span) => Date.parse(span.ts);
  const baseMs = roots.length
    ? Math.min(...roots.map(rootStart))
    : 0;
  const endMs = spans.length
    ? Math.max(...spans.map((span) => Date.parse(span.ts) + span.duration_ms))
    : baseMs;
  const walk = (list: Span[], depth: number, out: WaterfallRow[]) => {
    list
      .slice()
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
      .forEach((span) => {
        const children = kids.get(span.span_id) ?? [];
        const startMs = Date.parse(span.ts) - baseMs;
        const childUnion = intervalUnionMs(
          children.map((child) => ({
            start: Date.parse(child.ts) - Date.parse(span.ts),
            duration: child.duration_ms,
          })),
        );
        out.push({
          span,
          depth,
          startMs,
          selfMs: Math.max(0, span.duration_ms - childUnion),
        });
        walk(children, depth + 1, out);
      });
    return out;
  };
  return {
    rows: walk(roots, missingParent ? 1 : 0, []),
    baseMs,
    totalMs: Math.max(0, endMs - baseMs),
    missingParent,
    orphanCount: missingParent ? roots.length : 0,
  };
}

export function ancestorIds(spans: Span[], spanId: string): Set<string> {
  const byId = new Map(spans.map((span) => [span.span_id, span]));
  const seen = new Set<string>();
  let cur = byId.get(spanId);
  while (cur?.parent_span_id) {
    if (seen.has(cur.parent_span_id)) {
      break;
    }
    seen.add(cur.parent_span_id);
    cur = byId.get(cur.parent_span_id);
  }
  return seen;
}

export function traceTabLabel(value: string): string {
  return `trace ${value.slice(0, 12)}`;
}
