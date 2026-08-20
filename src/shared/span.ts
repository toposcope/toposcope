export const TRACE_SPAN_CAP = 500;

export const spanStatuses = ["unset", "ok", "error"] as const;
export type SpanStatus = (typeof spanStatuses)[number];

export type Span = {
  trace_id: string;
  span_id: string;
  parent_span_id: string;
  service: string;
  name: string;
  ts: string;
  duration_ms: number;
  status: SpanStatus;
  attrs: Record<string, string>;
};

export type TraceResponse = {
  spans: Span[];
  total: number;
};

export type SpanLink = {
  span_id: string;
  parent_span_id: string;
  duration_ms: number;
};

/** Keep the slowest branches and walk to the root so a 500-cap still connects. */
export function pickSlowestBranches(
  spans: SpanLink[],
  cap = TRACE_SPAN_CAP,
): Set<string> {
  if (spans.length <= cap) {
    return new Set(spans.map((span) => span.span_id));
  }
  const byId = new Map(spans.map((span) => [span.span_id, span]));
  const ranked = spans.slice().sort((a, b) => b.duration_ms - a.duration_ms);
  const keep = new Set<string>();
  for (const span of ranked) {
    if (keep.size >= cap) {
      break;
    }
    const chain: string[] = [];
    const seen = new Set<string>();
    let cur: SpanLink | undefined = span;
    while (cur && !seen.has(cur.span_id)) {
      seen.add(cur.span_id);
      chain.push(cur.span_id);
      cur = cur.parent_span_id ? byId.get(cur.parent_span_id) : undefined;
    }
    chain.reverse();
    for (const id of chain) {
      if (keep.size >= cap) {
        break;
      }
      keep.add(id);
    }
  }
  return keep;
}
