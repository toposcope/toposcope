import { clickhouseQuery } from "./clickhouse";
import { metricUnitOf } from "./metric";

/** What this process has seen or looked up. Ingest and query share it. */
const known = new Map<string, string | null>();

/**
 * A name remembers the unit it was last sent with, beside its kind. A point
 * sent without one leaves it as it was. Writes only the names whose unit is
 * new or changed.
 */
export async function rememberMetricUnits(units: ReadonlyMap<string, string>): Promise<void> {
  const changed = [...units].filter(([name, unit]) => known.get(name) !== unit);
  if (changed.length === 0) {
    return;
  }
  for (const [name, unit] of changed) {
    known.set(name, unit);
  }
}

/** The unit a name was last sent with, or null when it never came with one. */
export async function metricUnit(name: string): Promise<string | null> {
  const cached = known.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const rows = await clickhouseQuery<{ unit: string }>(
    // Read off the points themselves (#331): the newest that came with one, point or bucket.
    `SELECT unit FROM (
       SELECT unit, ts FROM metrics WHERE tenant_id = {tenant_id:String} AND name = {metric_name:String} AND unit != '' ORDER BY ts DESC LIMIT 1
       UNION ALL
       SELECT unit, ts FROM metric_buckets WHERE tenant_id = {tenant_id:String} AND name = {metric_name:String} AND unit != '' ORDER BY ts DESC LIMIT 1
     ) ORDER BY ts DESC LIMIT 1`,
    { tenant_id: "default", metric_name: name },
  );

  const found = metricUnitOf(rows[0]?.unit);
  known.set(name, found);
  return found;
}

/** Tests start from a process that has seen nothing. */
export function forgetMetricUnits(): void {
  known.clear();
}
