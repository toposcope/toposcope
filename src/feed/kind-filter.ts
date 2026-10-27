import { isCoreField, requireCompiled, type QueryNode } from "../query/compile";
import type { OtherKind } from "./feed";

/**
 * A link's filter on kinds other than logs (#326). The same `q`, compiled against each kind by the
 * fields it has. When `q` names a field a kind lacks, that kind is not sent at all, and the reason
 * names the field. An empty `q` sends every kind whole.
 */
export type KindFilter = { sql: string } | { not_sent: string };

type Columns = {
  service: string | null;
  host: string | null;
  /** The map other keys are read from, or null when the kind has none. */
  map: string | null;
};

const columns: Record<Exclude<OtherKind, "profile_samples">, Columns> = {
  spans: { service: "service", host: "attrs['host.name']", map: "attrs" },
  metrics: { service: "labels['service']", host: "labels['host']", map: "labels" },
  metric_buckets: { service: "labels['service']", host: "labels['host']", map: "labels" },
  // A monitor has no service until it names one (#335).
  monitor_results: { service: null, host: "host", map: null },
};

class Blocked extends Error {
  constructor(readonly field: string) {
    super(field);
  }
}

function bind(params: Record<string, string>, value: string, type = "String"): string {
  let i = 0;
  while (`kf${i}` in params) i++;
  params[`kf${i}`] = value;
  return `{kf${i}:${type}}`;
}

function emit(node: QueryNode | null, cols: Columns, params: Record<string, string>): string {
  if (!node) return "";
  switch (node.op) {
    case "and":
    case "or": {
      const a = emit(node.a, cols, params);
      const b = emit(node.b, cols, params);
      if (!a) return b;
      if (!b) return a;
      return `(${a} ${node.op === "and" ? "AND" : "OR"} ${b})`;
    }
    case "not": {
      const inner = emit(node.a, cols, params);
      return inner ? `NOT (${inner})` : "";
    }
    case "kv": {
      let col: string | null;
      if (node.key === "toposcope") col = "toposcope";
      else if (node.key === "service") col = cols.service;
      else if (node.key === "host") col = cols.host;
      else if (isCoreField(node.key)) col = null; // level
      else col = cols.map ? `${cols.map}[${bind(params, node.key)}]` : null;
      if (col === null) throw new Blocked(node.key);
      const value = bind(params, node.value);
      return node.glob ? `startsWith(${col}, ${value})` : `${col} = ${value}`;
    }
    case "cmp": {
      if (!cols.map) throw new Blocked(node.key);
      const n = bind(params, String(node.n), "Float64");
      return `ifNull(toFloat64OrNull(${cols.map}[${bind(params, node.key)}]) ${node.cmp} ${n}, 0)`;
    }
    case "text":
      throw new Blocked("words in the message");
    default: {
      const never: never = node;
      return never;
    }
  }
}

function reason(field: string, kind: OtherKind): string {
  if (field === "service" && kind === "monitor_results") return "the filter names service, and a monitor has none yet";
  return field === "words in the message" ? "the filter names words in the message" : `the filter names ${field}`;
}

/** The SQL that keeps `kind`'s rows the filter lets through, or why none go. */
export function kindFilter(q: string, kind: OtherKind, params: Record<string, string>): KindFilter {
  if (q.trim() === "") return { sql: "" };
  const ast = requireCompiled(q).ast;
  if (kind === "profile_samples") return profileFilter(ast, params);
  try {
    return { sql: emit(ast, columns[kind], params) };
  } catch (err) {
    if (err instanceof Blocked) return { not_sent: reason(err.field, kind) };
    throw err;
  }
}

/**
 * A profile goes when the span it belongs to went (decided 2026-10-27): its `(trace_id, span_id)`
 * is a span the filter lets through, in this range or before. A profile with no span goes by its
 * `service` (and `toposcope`) alone; when the filter names anything else, those do not go.
 */
function profileFilter(ast: QueryNode | null, params: Record<string, string>): KindFilter {
  let spanSql: string;
  try {
    spanSql = emit(ast, columns.spans, params);
  } catch (err) {
    if (err instanceof Blocked) return { not_sent: `they go with their spans, and ${reason(err.field, "spans")}` };
    throw err;
  }
  const withSpan = `(span_id != '' AND (trace_id, span_id) IN (SELECT trace_id, span_id FROM spans WHERE tenant_id = 'default' AND seq <= {through:UInt64}${spanSql ? ` AND ${spanSql}` : ""}))`;
  let alone = "0";
  try {
    alone = emit(ast, { service: "service", host: null, map: null }, params) || "1";
  } catch (err) {
    if (!(err instanceof Blocked)) throw err;
  }
  return { sql: `(${withSpan} OR (span_id = '' AND ${alone}))` };
}
