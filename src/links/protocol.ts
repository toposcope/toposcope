import type { Context } from "hono";
import { instanceId, instanceName } from "../control/instance";
import { getRetentionDays } from "../control/settings";
import { readFeed, type FeedReply } from "../feed/feed";
import { insertPulled, insertPulledMarks } from "../ingest/pulled";
import { hereName } from "../shared/here";
import { hashSecret, newSecret } from "./key";
import {
  getLinkKey,
  keyState,
  linkBySecret,
  linkId,
  noteContact,
  removeLink,
  saveLink,
  useLinkKey,
  type LinkRecord,
} from "./store";

/**
 * What one instance says to another over a link (#136), under `/link/v1/`. Not behind the
 * operator password: a lookup and a claim prove the key's secret, and everything after proves
 * the link's own secret. A link's secret reads its feed and nothing else.
 */

export type PeerInfo = { id: string; name: string; url: string };

function bearer(c: Context): string | null {
  const header = c.req.header("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() || null : null;
}

async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The key behind a lookup or claim, when the secret matches. */
function provenKey(body: Record<string, unknown> | null) {
  const kid = typeof body?.kid === "string" ? body.kid : "";
  const secret = typeof body?.secret === "string" ? body.secret : "";
  const key = kid ? getLinkKey(kid) : null;
  if (!key || !secret || key.secret_hash !== hashSecret(secret)) {
    return null;
  }
  return key;
}

/** A paste's one lookup before confirm: is the key still unused, and used by how many. */
export async function lookupRoute(c: Context): Promise<Response> {
  const key = provenKey(await jsonBody(c));
  if (!key) {
    return c.json({ error: "No such key here" }, 404);
  }
  return c.json({
    kind: key.kind,
    name: instanceName(),
    state: keyState(key),
    uses: key.uses,
    minted_at: key.created_at,
    spent_at: key.spent_at,
    until: key.until,
  });
}

function peerFrom(body: Record<string, unknown> | null): PeerInfo | null {
  const peer = body?.peer as Record<string, unknown> | undefined;
  const id = typeof peer?.id === "string" ? peer.id.trim() : "";
  const name = typeof peer?.name === "string" ? peer.name.trim() : "";
  const url = typeof peer?.url === "string" ? peer.url.trim() : "";
  return id && name ? { id, name, url } : null;
}

/**
 * The paste is confirmed: the pasting side claims the key, and the two swap it for a secret of
 * their own. The minter keeps the secret's hash; the side that pasted keeps the secret, because
 * it is the side that connects.
 */
export async function claimRoute(c: Context): Promise<Response> {
  const body = await jsonBody(c);
  const key = provenKey(body);
  if (!key) {
    return c.json({ error: "No such key here" }, 404);
  }
  const state = keyState(key);
  if (state !== "unused") {
    return c.json({ error: `The key is ${state}`, state }, 409);
  }
  const peer = peerFrom(body);
  if (!peer) {
    return c.json({ error: "peer { id, name } is required" }, 400);
  }
  if (peer.id === instanceId()) {
    return c.json({ error: "A link joins two instances; this key was minted here" }, 409);
  }
  const secret = newSecret();
  const link = saveLink({
    id: linkId(),
    // An offer's minter is the source; an invite's minter pulls.
    role: key.kind === "offer" ? "serve" : "pull",
    connects: "they",
    peer_id: peer.id,
    peer_name: peer.name,
    peer_url: peer.url,
    q: key.q,
    kid: key.kid,
    secret: null,
    secret_hash: hashSecret(secret),
    created_at: Date.now(),
  });
  useLinkKey(key.kid);
  return c.json({
    link: link.id,
    secret,
    minter: { id: instanceId(), name: instanceName() ?? "" },
    q: key.q,
    kind: key.kind,
  });
}

function linkFor(c: Context): LinkRecord | null {
  const secret = bearer(c);
  return secret ? linkBySecret(secret) : null;
}

/** A puller reads its feed: the rows after where it stands that its link's filter matches. */
export async function linkFeedRoute(c: Context): Promise<Response> {
  const link = linkFor(c);
  if (!link || link.role !== "serve") {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const after = Number(c.req.query("after") ?? "0");
  if (!Number.isSafeInteger(after) || after < 0) {
    return c.json({ error: "after is a position: a whole number, 0 or more" }, 400);
  }
  const limitRaw = c.req.query("limit");
  const reply = await readFeed({
    id: link.id,
    q: link.q,
    after,
    limit: limitRaw ? Number(limitRaw) : undefined,
    retentionDays: getRetentionDays(),
    hereId: instanceId(),
  });
  // Where the puller will stand after this read, and when that position arrived here.
  noteContact(link.id, {
    at: Date.now(),
    position: reply.through,
    settled: reply.settled,
    ...(reply.arrived ? { arrived_at: reply.arrived } : {}),
    behind_rows: link.q.trim() === "" ? Math.max(0, reply.settled - reply.through) : null,
    last_error: null,
  });
  return c.json({ ...reply, source: { id: instanceId(), name: instanceName() ?? "" } });
}

/**
 * A link where the source connects (#137): the source pasted the key and calls out. It asks
 * where the puller stands, reads its own feed from there and delivers the range. The puller
 * keeps the position; the source's own store is still the buffer.
 */
export async function linkAskRoute(c: Context): Promise<Response> {
  const link = linkFor(c);
  if (!link || link.role !== "pull" || link.connects !== "they") {
    return c.json({ error: "Unauthorized" }, 401);
  }
  noteContact(link.id, { at: Date.now(), last_error: null });
  return c.json({ after: link.position, limit: 1_000 });
}

/** The range the source read for us: stored as it came, and the position moves to its end. */
export async function linkRowsRoute(c: Context): Promise<Response> {
  const link = linkFor(c);
  if (!link || link.role !== "pull" || link.connects !== "they") {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const reply = (await jsonBody(c)) as (FeedReply & { source?: { id: string; name: string } }) | null;
  if (!reply || !Array.isArray(reply.rows) || !Number.isSafeInteger(reply.after) || !Number.isSafeInteger(reply.through)) {
    return c.json({ error: "Expected a feed reply" }, 400);
  }
  // A range that does not start where we stand is stale (a retry after we moved on): ask again.
  if (reply.after !== link.position) {
    return c.json({ position: link.position, stale: true }, 409);
  }
  const source = { name: reply.source?.name || link.peer_name };
  const stored = await insertPulled(reply.rows, source, instanceId());
  await insertPulledMarks(reply.marks ?? [], source, hereName());
  const gone =
    reply.gone && link.gone_from !== null && link.gone_to !== null
      ? { from: Math.min(link.gone_from, reply.gone.from), to: Math.max(link.gone_to, reply.gone.to) }
      : (reply.gone ?? (link.gone_from !== null && link.gone_to !== null ? { from: link.gone_from, to: link.gone_to } : null));
  noteContact(link.id, {
    at: Date.now(),
    position: reply.through,
    settled: reply.settled,
    ...(reply.arrived ? { arrived_at: reply.arrived } : {}),
    behind_rows: link.q.trim() === "" ? Math.max(0, reply.settled - reply.through) : null,
    gone_from: gone?.from ?? null,
    gone_to: gone?.to ?? null,
    peer_name: reply.source?.name || link.peer_name,
    last_error: null,
  });
  return c.json({ position: reply.through, stored: stored.stored });
}

/** The other side removed the link: stop here too. Rows already moved stay where they are. */
export async function linkRemoveRoute(c: Context): Promise<Response> {
  const link = linkFor(c);
  if (!link) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  removeLink(link.id);
  return c.json({ ok: true });
}
