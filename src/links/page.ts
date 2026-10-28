import { stampUpdated } from "../control/actors";
import type { Context } from "hono";
import { compileQuery } from "../query/compile";
import { clickhouseQuery, toIsoTimestamp } from "../shared/clickhouse";
import { getDb } from "../control/index";
import { getLink, volumeDay, type LinkRecord } from "./store";
import { feedKinds, kindsOf, kindsText, linkKinds, parseLinkKinds, type LinkKind } from "./kinds";
import { heldSources, type HeldSource } from "../shared/held";
import { behindMs, heldLinks, upstreamFor } from "./upstream";

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
  /** A line per kind (#329, frame 33b): on one position, each with its own state and volume. */
  kinds: KindLine[];
  /** Pull: how far behind the peer is here, in time; 0 when caught up. Serve: null. */
  behind_ms: number | null;
  /**
   * Sources further away whose rows come through this link (#334). Pull: as the peer last said,
   * added up with this link. Serve: what this side tells the peer, so the region's page says how
   * far behind the edge is.
   */
  further: Array<HeldSource & { behind_ms: number }>;
};

/** Where the link's peer stands here, and its sources further away, as this side's tells read them. */
export function linkReach(link: LinkRecord, now = Date.now()): Pick<LinkPage, "behind_ms" | "further"> {
  if (link.role === "serve") {
    return { behind_ms: null, further: upstreamFor(link, now).map((s) => ({ ...s, behind_ms: behindMs(s.state, now) })) };
  }
  const sources = heldSources(heldLinks([link]), now);
  const peer = sources.find((s) => s.name === link.peer_name);
  return {
    behind_ms: peer ? behindMs(peer.state, now) : null,
    further: sources.filter((s) => s.name !== link.peer_name).map(({ via: _via, ...s }) => ({ ...s, behind_ms: behindMs(s.state, now) })),
  };
}

export type KindLine = {
  kind: LinkKind;
  ticked: boolean;
  state: "caught up" | "behind" | "a hole" | "not sent" | "unticked at the source" | "paused";
  not_sent?: string;
  gone?: { from: number; to: number };
  rows_day: number;
  bytes_day: number;
};

/** Each kind's line, from the link's kinds, its last word per kind and its volume over a day. */
export function kindLines(link: LinkRecord, paused: boolean, now = Date.now()): KindLine[] {
  const ticked = new Set(kindsOf(link.kinds));
  const state = JSON.parse(link.kind_state ?? "{}") as Record<string, { gone?: { from: number; to: number }; not_sent?: string }>;
  const volume = volumeDay(link.id, now);
  const behind = link.position < link.settled;
  return linkKinds.map((kind) => {
    const feed = feedKinds([kind]);
    const words = feed.map((k) => state[k]).find((s) => s?.not_sent) ?? feed.map((k) => state[k]).find((s) => s?.gone);
    const rows = feed.reduce((n, k) => n + (volume[k]?.rows ?? 0), 0);
    const bytes = feed.reduce((n, k) => n + (volume[k]?.bytes ?? 0), 0);
    const line: KindLine = {
      kind,
      ticked: ticked.has(kind),
      state: !ticked.has(kind)
        ? "unticked at the source"
        : paused
          ? "paused"
          : words?.not_sent
            ? "not sent"
            : words?.gone
              ? "a hole"
              : behind
                ? "behind"
                : "caught up",
      rows_day: rows,
      bytes_day: bytes,
    };
    if (ticked.has(kind) && words?.not_sent) line.not_sent = words.not_sent;
    if (ticked.has(kind) && words?.gone) line.gone = words.gone;
    return line;
  });
}

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
    kinds: kindLines(link, isPaused(link)),
    ...linkReach(link),
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
  const body = (await c.req.json().catch(() => null)) as { paused?: unknown; q?: unknown; kinds?: unknown } | null;
  if (!body || typeof body !== "object") {
    return c.json({ error: "Expected an object" }, 400);
  }
  // Kinds are checked before anything is saved, so a refused change leaves the link as it was (#329).
  let nextKinds: LinkKind[] | null = null;
  if (body.kinds !== undefined) {
    if (link.role !== "serve") {
      return c.json({ error: "the source holds which kinds this link carries: change them there" }, 409);
    }
    const kinds = parseLinkKinds(body.kinds);
    if ("error" in kinds) {
      return c.json({ error: kinds.error }, 400);
    }
    const had = new Set(kindsOf(link.kinds));
    if (kinds.some((k) => !had.has(k))) {
      return c.json({ error: "A kind is never added to a key already used: to send it too, make a new key" }, 409);
    }
    nextKinds = kinds;
  }
  if (body.paused !== undefined) {
    if (typeof body.paused !== "boolean") {
      return c.json({ error: "paused is true or false" }, 400);
    }
    getDb().query("UPDATE links SET paused = ? WHERE id = ?").run(body.paused ? 1 : 0, link.id);
    stampUpdated("links", link.id);
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
    stampUpdated("links", link.id);
  }
  if (nextKinds) {
    getDb().query("UPDATE links SET kinds = ? WHERE id = ?").run(kindsText(nextKinds), link.id);
    stampUpdated("links", link.id);
  }
  return c.json(await linkPage(link.id));
}
