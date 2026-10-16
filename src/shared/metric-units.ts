import { clickhouseInsertJsonEachRow, clickhouseQuery } from "./clickhouse";
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
  const seen = new Date().toISOString().replace("T", " ").replace("Z", "");
  await clickhouseInsertJsonEachRow(
    changed
      .map(([name, unit]) => JSON.stringify({ tenant_id: "default", name, unit, seen }))
      .join("\n"),
    "metric_units",
  );
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
    `SELECT argMax(unit, seen) AS unit
     FROM metric_units
     WHERE tenant_id = {tenant_id:String} AND name = {metric_name:String}
     HAVING count() > 0`,
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
