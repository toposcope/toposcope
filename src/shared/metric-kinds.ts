import { clickhouseInsertJsonEachRow, clickhouseQuery } from "./clickhouse";

/**
 * How a metric's points are read. A gauge is a level: each bar is the average
 * of its points. A counter is an amount per interval: each bar is their sum.
 * A histogram is a distribution: its count and sum are the counters
 * `<name>.count` and `<name>.sum`, and its buckets hold the percentiles.
 * A name with no kind — one posted as a plain JSON point — reads as a gauge.
 */
export type MetricKind = "gauge" | "counter" | "histogram";

const metricKinds: readonly MetricKind[] = ["gauge", "counter", "histogram"];

/** What this process has seen or looked up. Ingest and query share it. */
const known = new Map<string, MetricKind | null>();

/** A name remembers its kind. Writes only the names whose kind is new or changed. */
export async function rememberMetricKinds(kinds: ReadonlyMap<string, MetricKind>): Promise<void> {
  const changed = [...kinds].filter(([name, kind]) => known.get(name) !== kind);
  if (changed.length === 0) {
    return;
  }
  const seen = new Date().toISOString().replace("T", " ").replace("Z", "");
  await clickhouseInsertJsonEachRow(
    changed
      .map(([name, kind]) => JSON.stringify({ tenant_id: "default", name, kind, seen }))
      .join("\n"),
    "metric_kinds",
  );
  for (const [name, kind] of changed) {
    known.set(name, kind);
  }
}

/** The kind a name was last sent as, or null when it never came with one. */
export async function metricKind(name: string): Promise<MetricKind | null> {
  const cached = known.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const rows = await clickhouseQuery<{ kind: string }>(
    `SELECT argMax(kind, seen) AS kind
     FROM metric_kinds
     WHERE tenant_id = {tenant_id:String} AND name = {metric_name:String}
     HAVING count() > 0`,
    { tenant_id: "default", metric_name: name },
  );
  const found = metricKinds.find((kind) => kind === rows[0]?.kind) ?? null;
  known.set(name, found);
  return found;
}

/** Tests start from a process that has seen nothing. */
export function forgetMetricKinds(): void {
  known.clear();
}
