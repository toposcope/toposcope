import { clickhouseQuery } from "../shared/clickhouse";
import { activeEquals, compileQuery, type QueryNode } from "../query/compile";

/**
 * Saved hunts that read hosts that have gone quiet (sheet 51b): a host is gone when it has sent
 * nothing for 7 days; a hunt counts when every host its query names is gone. Home offers to
 * archive them together.
 */

export const goneAfterMs = 7 * 24 * 60 * 60_000;

/** A gone host, when it last sent anything (null: nothing kept), and how many gone hunts read it. */
export type GoneHost = { host: string; last_seen: string | null; hunts: number };
export type GoneHunts = { saved_ids: string[]; hosts: GoneHost[] };

/** True when every leaf under this node is `host:x`: an OR of hosts still reads only those hosts. */
function onlyHosts(node: QueryNode | null): boolean {
  if (!node) {
    return true;
  }
  if (node.op === "and" || node.op === "or") {
    return onlyHosts(node.a) && onlyHosts(node.b);
  }
  return node.op === "kv" && node.key === "host" && !node.glob;
}

/** True when an OR somewhere reaches past `host:x`: lines from other hosts could match through it. */
function orReachesPast(node: QueryNode | null): boolean {
  if (!node) {
    return false;
  }
  if (node.op === "or") {
    return !onlyHosts(node);
  }
  if (node.op === "and") {
    return orReachesPast(node.a) || orReachesPast(node.b);
  }
  // A NOT only narrows what an AND beside it already holds to its hosts.
  return false;
}

/**
 * The hosts a query names as `host:x`, not negated and not a glob. None when it fails to compile,
 * or when an OR could let lines from other hosts through.
 */
export function queryHosts(q: string): string[] {
  try {
    const compiled = compileQuery(q);
    if (compiled.faults.length > 0 || orReachesPast(compiled.ast)) {
      return [];
    }
    return activeEquals(compiled).host ?? [];
  } catch {
    return [];
  }
}

/**
 * The gone hunts among `saved`, from each named host's last minute with any line (`lastSeen`;
 * a host missing from it sent nothing in what is kept). Hosts come oldest last-seen first.
 */
export function goneHunts(saved: readonly { id: string; query: string }[], lastSeen: ReadonlyMap<string, number>, nowMs: number): GoneHunts {
  const gone = (host: string) => {
    const at = lastSeen.get(host);
    return at === undefined || nowMs - at >= goneAfterMs;
  };
  const ids: string[] = [];
  const hosts = new Map<string, number>();
  for (const s of saved) {
    const named = queryHosts(s.query);
    if (named.length > 0 && named.every(gone)) {
      ids.push(s.id);
      for (const h of named) {
        hosts.set(h, (hosts.get(h) ?? 0) + 1);
      }
    }
  }
  const list = [...hosts]
    .map(([host, hunts]) => ({ host, hunts, at: lastSeen.get(host) ?? null }))
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.host.localeCompare(b.host))
    .map(({ host, hunts, at }) => ({ host, last_seen: at === null ? null : new Date(at).toISOString(), hunts }));
  return { saved_ids: ids, hosts: list };
}

/** Each host's newest minute with any line, for the hosts asked about. */
export async function hostsLastSeen(hosts: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (hosts.length === 0) {
    return out;
  }
  const rows = await clickhouseQuery<{ host: string; last: string }>(
    `
      SELECT host, toString(max(minute)) AS last
      FROM logs_by_minute
      WHERE tenant_id = {tenant_id:String}
        AND host IN JSONExtract({hosts:String}, 'Array(String)')
      GROUP BY host
    `,
    { tenant_id: "default", hosts: JSON.stringify([...hosts]) },
  );
  for (const row of rows) {
    const ms = Date.parse(`${row.last.replace(" ", "T")}Z`);
    if (Number.isFinite(ms)) {
      out.set(row.host, ms);
    }
  }
  return out;
}

/** The gone hunts among `saved`, read from ClickHouse; none when it cannot be read. */
export async function readGoneHunts(saved: readonly { id: string; query: string }[], nowMs: number): Promise<GoneHunts> {
  const named = [...new Set(saved.flatMap((s) => queryHosts(s.query)))];
  const lastSeen = await hostsLastSeen(named).catch(() => null);
  return lastSeen ? goneHunts(saved, lastSeen, nowMs) : { saved_ids: [], hosts: [] };
}
