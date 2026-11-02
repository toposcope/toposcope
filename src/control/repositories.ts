import type { Database } from "bun:sqlite";
import type { Context } from "hono";
import { getChangeMarkById, mapRow, markSelect, type MarkRow } from "../query/marks";
import { clickhouseQuery } from "../shared/clickhouse";
import { parseRepo, parseRepoPath, repoResourceKey, type Repo } from "../shared/code-links";
import type { ChangeMark } from "../shared/change-mark";
import { actorName, currentActorRef, type ActorName } from "./actors";
import { getDb } from "./index";

/**
 * Where each service's code lives (#393, frame 37i). A service's repository comes from
 * `vcs.repository.url.full` on its resource, else `repo` on its newest deploy mark, else a row an
 * Operator set here; one set here wins over both. Links only: no repository content is fetched, and
 * the one token, Connect GitHub's (#416, control/github.ts), only lists repositories for Set.
 * A row set here may also name the folder the service's stack paths start in (#413, 41e).
 */

export type RepoFrom = "set" | "resource" | "mark";

export type ServiceRepo = {
  service: string;
  repository: (Repo & { from: RepoFrom; path: string | null }) | null;
  /** The deploy mark `repo` was read from, when it is the one that counts or the fallback. */
  mark: { id: string; version: string } | null;
  set_by: ActorName | null;
  set_at: number | null;
};

export function migrateRepositories(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS repositories (
      service TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      set_by TEXT,
      set_at INTEGER NOT NULL
    );
  `);
  const cols = db.query("PRAGMA table_info(repositories)").all() as { name: string }[];
  if (!cols.some((col) => col.name === "path")) {
    db.run("ALTER TABLE repositories ADD COLUMN path TEXT");
  }
}

type SetRow = { service: string; url: string; path: string | null; set_by: string | null; set_at: number };

function setRows(db: Database = getDb()): SetRow[] {
  return db.query("SELECT service, url, path, set_by, set_at FROM repositories ORDER BY service").all() as SetRow[];
}

/** Rows a sender's resource names, newest first per service: the minute rollup, then spans and a short logs scan for a URL too long for the rollup. */
async function resourceRepos(service?: string): Promise<Map<string, string>> {
  const params: Record<string, string> = { key: repoResourceKey };
  const only = service !== undefined ? "AND service = {service:String}" : "";
  if (service !== undefined) {
    params.service = service;
  }
  // A scan reads what it can in its budget and stops: any one row naming the repository is enough.
  const budget = "SETTINGS max_rows_to_read = 5000000, max_execution_time = 4, read_overflow_mode = 'break', timeout_overflow_mode = 'break'";
  const [rolled, spans, logs] = await Promise.all([
    clickhouseQuery<{ service: string; url: string }>(
      `SELECT service, argMax(value, minute) AS url FROM logs_attr_values_by_minute
       WHERE tenant_id = 'default' AND key = {key:String} AND minute >= now() - INTERVAL 7 DAY ${only}
       GROUP BY service`,
      params,
    ),
    clickhouseQuery<{ service: string; url: string }>(
      `SELECT service, argMax(attrs[{key:String}], ts) AS url FROM spans
       WHERE tenant_id = 'default' AND ts >= now() - INTERVAL 1 DAY AND attrs[{key:String}] != '' ${only}
       GROUP BY service ${budget}`,
      params,
    ).catch(() => []),
    clickhouseQuery<{ service: string; url: string }>(
      `SELECT service, argMax(attr_map[{key:String}], ts) AS url FROM logs
       WHERE tenant_id = 'default' AND ts >= now() - INTERVAL 1 HOUR AND lengthUTF8(attr_map[{key:String}]) > 64 ${only}
       GROUP BY service ${budget}`,
      params,
    ).catch(() => []),
  ]);
  const out = new Map<string, string>();
  for (const row of [...logs, ...spans, ...rolled]) {
    if (row.url && parseRepo(row.url)) {
      out.set(row.service, row.url);
    }
  }
  return out;
}

/** Each service's newest deploy mark that names a `repo`. */
async function markRepos(service?: string): Promise<Map<string, { url: string; id: string; version: string }>> {
  const params: Record<string, string> = {};
  const only = service !== undefined ? "AND service = {service:String}" : "";
  if (service !== undefined) {
    params.service = service;
  }
  const rows = await clickhouseQuery<{ service: string; url: string; id: string; version: string; title: string }>(
    `SELECT service, argMax(attrs['repo'], ts) AS url, argMax(id, ts) AS id, argMax(attrs['version'], ts) AS version, argMax(title, ts) AS title
     FROM change_marks
     WHERE tenant_id = 'default' AND kind = 'deploy' AND service != '' AND attrs['repo'] != '' ${only}
     GROUP BY service`,
    params,
  );
  return new Map(rows.map((r) => [r.service, { url: r.url, id: r.id, version: r.version || r.title }]));
}

/** Every service seen in the last 7 days, with a deploy mark, or set here. */
async function knownServices(): Promise<string[]> {
  const rows = await clickhouseQuery<{ service: string }>(
    `SELECT DISTINCT service FROM logs_by_minute WHERE tenant_id = 'default' AND minute >= now() - INTERVAL 7 DAY AND service != ''
     UNION DISTINCT
     SELECT DISTINCT service FROM change_marks WHERE tenant_id = 'default' AND kind = 'deploy' AND service != ''`,
  );
  return rows.map((r) => r.service);
}

/** The three sources, in their order: one set here, the resource, the newest deploy mark. */
export function pickRepo(
  service: string,
  set: SetRow | undefined,
  resource: string | undefined,
  mark: { url: string; id: string; version: string } | undefined,
  db: Database = getDb(),
): ServiceRepo {
  const fromMark = mark ? parseRepo(mark.url) : null;
  const fromResource = resource ? parseRepo(resource) : null;
  const fromSet = set ? parseRepo(set.url) : null;
  const repository = fromSet
    ? { ...fromSet, from: "set" as const, path: set?.path || null }
    : fromResource
      ? { ...fromResource, from: "resource" as const, path: null }
      : fromMark
        ? { ...fromMark, from: "mark" as const, path: null }
        : null;
  return {
    service,
    repository,
    mark: fromMark && mark ? { id: mark.id, version: mark.version } : null,
    set_by: set ? actorName(set.set_by, db) : null,
    set_at: set?.set_at ?? null,
  };
}

/** One service's repository, or null when none is known. */
export async function repoFor(service: string, db: Database = getDb()): Promise<ServiceRepo> {
  const set = setRows(db).find((r) => r.service === service);
  if (set) {
    return pickRepo(service, set, undefined, undefined, db);
  }
  const [resource, marks] = await Promise.all([resourceRepos(service), markRepos(service)]);
  return pickRepo(service, undefined, resource.get(service), marks.get(service), db);
}

/** `GET /api/repositories`: every service and where its code lives (37i). */
export async function listRepositoriesRoute(c: Context): Promise<Response> {
  const db = getDb();
  const sets = setRows(db);
  const [services, resource, marks] = await Promise.all([knownServices(), resourceRepos(), markRepos()]);
  const names = [...new Set([...services, ...sets.map((s) => s.service), ...resource.keys(), ...marks.keys()])].sort();
  const bySet = new Map(sets.map((s) => [s.service, s]));
  return c.json({
    repositories: names.map((name) => pickRepo(name, bySet.get(name), resource.get(name), marks.get(name), db)),
  });
}

/**
 * `PUT /api/repositories/:service`: set one by hand; it wins over the resource and the marks.
 * `path` sets the folder ("" clears it); left out, the folder stays while the repository does.
 */
export async function setRepositoryRoute(c: Context): Promise<Response> {
  const service = decodeURIComponent(c.req.param("service") ?? "").trim();
  if (!service) {
    return c.json({ error: "service is required" }, 400);
  }
  const body = (await c.req.json().catch(() => null)) as { url?: unknown; path?: unknown } | null;
  const raw = typeof body?.url === "string" ? body.url : "";
  const repo = parseRepo(raw);
  if (!repo) {
    return c.json({ error: "url must be a repository: https://host/owner/name, host/owner/name or git@host:owner/name", field: "url" }, 400);
  }
  const db = getDb();
  let path: string | null;
  if (body?.path === undefined) {
    const was = setRows(db).find((r) => r.service === service);
    path = was && was.url === repo.url ? was.path : null;
  } else {
    const folder = typeof body.path === "string" ? parseRepoPath(body.path) : null;
    if (folder === null) {
      return c.json({ error: "path must be a folder in the repository, like services/pay", field: "path" }, 400);
    }
    path = folder || null;
  }
  db.query(
    "INSERT INTO repositories (service, url, path, set_by, set_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(service) DO UPDATE SET url = excluded.url, path = excluded.path, set_by = excluded.set_by, set_at = excluded.set_at",
  ).run(service, repo.url, path, currentActorRef(), Date.now());
  return c.json(await repoFor(service, db));
}

/** `DELETE /api/repositories/:service`: clear the one set here; the resource or a mark counts again. */
export async function clearRepositoryRoute(c: Context): Promise<Response> {
  const service = decodeURIComponent(c.req.param("service") ?? "").trim();
  const db = getDb();
  const gone = db.query("DELETE FROM repositories WHERE service = ?").run(service);
  if (gone.changes === 0) {
    return c.json({ error: `No repository is set here for ${service}` }, 404);
  }
  return c.json(await repoFor(service, db));
}

type CodeMark = { id: string; ts: string; title: string; version: string; sha: string | null };

function codeMark(mark: ChangeMark): CodeMark {
  return {
    id: mark.id,
    ts: mark.ts,
    title: mark.title,
    version: mark.attrs.version ?? "",
    sha: mark.attrs.sha?.trim() || mark.attrs.commit?.trim() || null,
  };
}

/** The newest deploy of `service` with this version, or before `beforeTs`. */
async function deployMark(service: string, filter: { version?: string; beforeTs?: string }): Promise<ChangeMark | null> {
  const params: Record<string, string> = { service };
  const where: string[] = [];
  if (filter.version !== undefined) {
    where.push("attrs['version'] = {version:String}");
    params.version = filter.version;
  }
  if (filter.beforeTs !== undefined) {
    where.push("ts < parseDateTime64BestEffort({before:String})");
    params.before = filter.beforeTs;
  }
  const rows = await clickhouseQuery<MarkRow>(
    `SELECT ${markSelect} FROM change_marks
     WHERE tenant_id = 'default' AND kind = 'deploy' AND service = {service:String} AND ${where.join(" AND ")}
     ORDER BY ts DESC LIMIT 1`,
    params,
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * `GET /api/code`: what a link needs. With `mark`, that deploy, its service's repository and the
 * previous deploy of the same service (37g); with `service` and `version`, the deploy mark of that
 * version and the repository (37h).
 */
export async function codeRoute(c: Context): Promise<Response> {
  const markId = c.req.query("mark")?.trim();
  if (markId) {
    const mark = await getChangeMarkById(markId);
    if (!mark) {
      return c.json({ error: "No mark has that id" }, 404);
    }
    if (mark.kind !== "deploy" || !mark.service) {
      return c.json({ repository: null, mark: codeMark(mark), previous: null });
    }
    const [repo, previous] = await Promise.all([repoFor(mark.service), deployMark(mark.service, { beforeTs: mark.ts })]);
    return c.json({ repository: repo.repository, mark: codeMark(mark), previous: previous ? codeMark(previous) : null });
  }
  const service = c.req.query("service")?.trim();
  if (!service) {
    return c.json({ error: "service or mark is required" }, 400);
  }
  const version = c.req.query("version")?.trim();
  const [repo, mark] = await Promise.all([repoFor(service), version ? deployMark(service, { version }) : Promise.resolve(null)]);
  return c.json({ repository: repo.repository, mark: mark ? codeMark(mark) : null, previous: null });
}
