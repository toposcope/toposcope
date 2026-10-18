import { clickhouseInsertJsonEachRow, clickhouseQuery } from "./clickhouse";
import { metricDescriptionOf } from "./metric";

/** What this process has seen or looked up. Ingest and query share it. */
const known = new Map<string, string | null>();

/**
 * A name remembers the description it was last sent with (#167), as its unit
 * is remembered. A point sent without one leaves it as it was. Writes only the
 * names whose description is new or changed.
 */
export async function rememberMetricDescriptions(descriptions: ReadonlyMap<string, string>): Promise<void> {
  const changed = [...descriptions].filter(([name, description]) => known.get(name) !== description);
  if (changed.length === 0) {
    return;
  }
  const seen = new Date().toISOString().replace("T", " ").replace("Z", "");
  await clickhouseInsertJsonEachRow(
    changed
      .map(([name, description]) => JSON.stringify({ tenant_id: "default", name, description, seen }))
      .join("\n"),
    "metric_descriptions",
  );
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
    `SELECT argMax(description, seen) AS description
     FROM metric_descriptions
     WHERE tenant_id = {tenant_id:String} AND name = {metric_name:String}
     HAVING count() > 0`,
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
