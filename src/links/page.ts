import type { Context } from "hono";
import { compileQuery } from "../query/compile";
import { clickhouseQuery, toIsoTimestamp } from "../shared/clickhouse";
import { getDb } from "../control/index";
import { getLink, type LinkRecord } from "./store";

/**
 * A link's own page (#267, frame 26m): which way rows move, its scope, where it stands, the rows
 * it pulled over a day with gaps drawn as floors, and the two things done to it here: pause, and a
 * new scope when this side holds the scope. Nothing here shows the key again.
 */
export type LinkPage = {
  id: string;
  role: "pull" | "serve";
  peer: string;
  peer_url: string;
  q: string;
  paused: boolean;
  /** Whether this side's scope is the link's: rows leave here, so the filter is applied here. */
  scope_here: boolean;
  position: number;
  settled: number;
  behind_rows: number | null;
  arrived_at: string | null;
  last_contact_at: number | null;
  last_error: string | null;
  created_at: number;
  holes: Array<{ from: string; to: string }>;
  /** Rows that entered at the peer, per 15 minutes over 24 h (a pull link's rows only). */
  pulled: Array<{ t: string; n: number }>;
  pulled_24h: number;
};

export function isPaused(link: Pick<LinkRecord, "id">): boolean {
  const row = getDb().query("SELECT paused FROM links WHERE id = ?").get(link.id) as { paused: number } | null | undefined;
  return Boolean(row?.paused);
}

async function pulledRows(peer: string): Promise<Array<{ t: string; n: number }>> {
  const rows = await clickhouseQuery<{ t: string; n: string | number }>(
    `SELECT toStartOfFifteenMinutes(ts) AS t, count() AS n FROM logs
     WHERE tenant_id = 'default' AND toposcope = {peer:String} AND ts >= now64(3) - INTERVAL 1 DAY
     GROUP BY t ORDER BY t`,
    { peer },
  ).catch(() => []);
  return rows.map((r) => ({ t: toIsoTimestamp(String(r.t)), n: Number(r.n) }));
}

export async function linkPage(id: string): Promise<LinkPage | null> {
  const link = getLink(id);
  if (!link || link.removed_at !== null) {
    return null;
  }
  const pulled = link.role === "pull" && link.peer_name ? await pulledRows(link.peer_name) : [];
  return {
    id: link.id,
    role: link.role,
    peer: link.peer_name || link.peer_url,
    peer_url: link.peer_url,
    q: link.q,
    paused: isPaused(link),
    scope_here: link.role === "serve",
    position: link.position,
    settled: link.settled,
    behind_rows: link.behind_rows,
    arrived_at: link.arrived_at,
    last_contact_at: link.last_contact_at,
    last_error: link.last_error,
    created_at: link.created_at,
    holes: link.gone_from_at && link.gone_to_at ? [{ from: link.gone_from_at, to: link.gone_to_at }] : [],
    pulled,
    pulled_24h: pulled.reduce((n, b) => n + b.n, 0),
  };
}

/** `GET /api/links/:id`. */
export async function linkPageRoute(c: Context): Promise<Response> {
  const page = await linkPage(c.req.param("id") ?? "");
  return page ? c.json(page) : c.json({ error: "no such link" }, 404);
}

/** `PUT /api/links/:id` `{ paused?, q? }` — pause or resume; a new scope only where rows leave here. */
export async function updateLinkRoute(c: Context): Promise<Response> {
  const link = getLink(c.req.param("id") ?? "");
  if (!link || link.removed_at !== null) {
    return c.json({ error: "no such link" }, 404);
  }
  const body = (await c.req.json().catch(() => null)) as { paused?: unknown; q?: unknown } | null;
  if (!body || typeof body !== "object") {
    return c.json({ error: "Expected an object" }, 400);
  }
  if (body.paused !== undefined) {
    if (typeof body.paused !== "boolean") {
      return c.json({ error: "paused is true or false" }, 400);
    }
    getDb().query("UPDATE links SET paused = ? WHERE id = ?").run(body.paused ? 1 : 0, link.id);
  }
  if (body.q !== undefined) {
    if (typeof body.q !== "string") {
      return c.json({ error: "q is a string" }, 400);
    }
    if (link.role !== "serve") {
      return c.json({ error: "the source holds this link's scope: change it there" }, 409);
    }
    const compiled = compileQuery(body.q.trim());
    if (compiled.faults.length > 0) {
      return c.json({ error: compiled.faults[0]?.msg ?? "q does not compile", faults: compiled.faults }, 400);
    }
    getDb().query("UPDATE links SET q = ? WHERE id = ?").run(body.q.trim(), link.id);
  }
  return c.json(await linkPage(link.id));
}
