import { clickhouseQuery } from "./clickhouse";

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

/** A name's kind as this process last saw it sent; the point carries it (#331), so nothing is written here. */
export async function rememberMetricKinds(kinds: ReadonlyMap<string, MetricKind>): Promise<void> {
  const changed = [...kinds].filter(([name, kind]) => known.get(name) !== kind);
  if (changed.length === 0) {
    return;
  }
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
    // Read off the points themselves (#331): the newest that came with one, point or bucket.
    `SELECT kind FROM (
       SELECT kind, ts FROM metrics WHERE tenant_id = {tenant_id:String} AND name = {metric_name:String} AND kind != '' ORDER BY ts DESC LIMIT 1
       UNION ALL
       SELECT kind, ts FROM metric_buckets WHERE tenant_id = {tenant_id:String} AND name = {metric_name:String} AND kind != '' ORDER BY ts DESC LIMIT 1
     ) ORDER BY ts DESC LIMIT 1`,
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
