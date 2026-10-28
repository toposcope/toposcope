import { clickhouseQuery } from "./clickhouse";
import { metricDescriptionOf } from "./metric";

/** What this process has seen or looked up. Ingest and query share it. */
const known = new Map<string, string | null>();

/**
 * The description a name was last sent with (#167), as this process saw it. A point sent
 * without one leaves it as it was. The point carries it (#331), so nothing is written here.
 */
export async function rememberMetricDescriptions(descriptions: ReadonlyMap<string, string>): Promise<void> {
  const changed = [...descriptions].filter(([name, description]) => known.get(name) !== description);
  if (changed.length === 0) {
    return;
  }
  for (const [name, description] of changed) {
    known.set(name, description);
  }
}

/** The description a name was last sent with, or null when it never came with one. */
export async function metricDescription(name: string): Promise<string | null> {
  const cached = known.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const rows = await clickhouseQuery<{ description: string }>(
    // Read off the points themselves (#331): the newest that came with one, point or bucket.
    `SELECT description FROM (
       SELECT description, ts FROM metrics WHERE tenant_id = {tenant_id:String} AND name = {metric_name:String} AND description != '' ORDER BY ts DESC LIMIT 1
       UNION ALL
       SELECT description, ts FROM metric_buckets WHERE tenant_id = {tenant_id:String} AND name = {metric_name:String} AND description != '' ORDER BY ts DESC LIMIT 1
     ) ORDER BY ts DESC LIMIT 1`,
    { tenant_id: "default", metric_name: name },
  );

  const found = metricDescriptionOf(rows[0]?.description);
  known.set(name, found);
  return found;
}

/** Tests start from a process that has seen nothing. */
export function forgetMetricDescriptions(): void {
  known.clear();
}
