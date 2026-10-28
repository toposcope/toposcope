import type { Database } from "bun:sqlite";
import { getDb } from "../control/index";
import { allAlertRules, type AlertRule } from "../control/alerts";
import { stretchesBetween, type MonitorStretch } from "../alerts/monitor-store";
import { compileQuery, matchNode } from "../query/compile";
import { kindFilter } from "../feed/kind-filter";

/**
 * A source's monitors over a link (#333, decided 2026-10-27): their definitions and stretches
 * travel with their results, shown read-only at the collecting instance under the source's name.
 * They are SQLite state, not a stream, so the source sends a snapshot on the page that catches a
 * link up, filtered as the link's results are (by service, host and toposcope); the puller keeps
 * the newest snapshot of each source. Nothing is judged or called again at the puller.
 */
export type MonitorDefinition = Pick<
  AlertRule,
  "id" | "name" | "kind" | "source" | "state" | "enabled" | "threshold" | "opens_when" | "every_ms" | "grace_ms" | "last_result" | "last_value" | "last_result_at"
> & { service: string; host: string };

export type MonitorsSnapshot = {
  monitors: MonitorDefinition[];
  stretches: Array<Pick<MonitorStretch, "id" | "monitor_id" | "opened_at" | "resolved_at" | "closed_by" | "open_message">>;
};

/** Stretches open now, or resolved within this long, go in a snapshot. */
const stretchDays = 30;

/** The source's side: the monitors a link with this filter may send, or null when it sends none. */
export function monitorsSnapshot(q: string, here: string, now = Date.now(), db: Database = getDb()): MonitorsSnapshot | null {
  if ("not_sent" in kindFilter(q, "monitor_results", {})) {
    return null;
  }
  const ast = q.trim() === "" ? null : compileQuery(q).ast;
  const monitors = allAlertRules(db)
    .map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      source: r.source,
      state: r.state,
      enabled: r.enabled,
      threshold: r.threshold,
      opens_when: r.opens_when,
      every_ms: r.every_ms,
      grace_ms: r.grace_ms,
      last_result: r.last_result,
      last_value: r.last_value,
      last_result_at: r.last_result_at,
      service: r.service ?? "",
      host: r.host ?? "",
    }))
    .filter((m) => !ast || matchNode(ast, (key) => (key === "service" ? m.service : key === "host" ? m.host : key === "toposcope" ? here : "")));
  const ids = new Set(monitors.map((m) => m.id));
  const stretches = stretchesBetween(now - stretchDays * 86_400_000, now, db)
    .filter((s) => ids.has(s.monitor_id))
    .map(({ id, monitor_id, opened_at, resolved_at, closed_by, open_message }) => ({ id, monitor_id, opened_at, resolved_at, closed_by, open_message }));
  return { monitors, stretches };
}

/** The puller's side: the newest snapshot from a source replaces the one before. */
export function keepMonitorsSnapshot(source: string, snapshot: MonitorsSnapshot, now = Date.now(), db: Database = getDb()): void {
  db.query(
    `INSERT INTO pulled_monitors (source, snapshot, at) VALUES (?, ?, ?)
     ON CONFLICT (source) DO UPDATE SET snapshot = excluded.snapshot, at = excluded.at`,
  ).run(source, JSON.stringify(snapshot), now);
}

/** Every source's monitors, as Watch lists them under the source's name. */
export function pulledMonitors(db: Database = getDb()): Array<MonitorsSnapshot & { source: string; at: number }> {
  const rows = db.query("SELECT source, snapshot, at FROM pulled_monitors ORDER BY source").all() as Array<{ source: string; snapshot: string; at: number }>;
  return rows.map((r) => ({ source: r.source, at: r.at, ...(JSON.parse(r.snapshot) as MonitorsSnapshot) }));
}
