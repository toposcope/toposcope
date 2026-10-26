import type { Context, Next } from "hono";
import { mintTicket, parseShareEmbed, ticketPrefix, ticketShareRow } from "./embed";
import { parseShareLimits } from "./limits";
import { formatShareScope, parseShareScope, type ShareScope } from "./scope";
import { deriveShareScope, parseSharePanels, scopeGaps } from "./panels";
import { clickhouseQuery, toIsoTimestamp } from "../shared/clickhouse";
import { dropShareCache } from "./cache";
import { noteLimited, noteRead, pendingUse, takeRead } from "./use";
import {
  listShares,
  parseShareExpiry,
  parseShareName,
  putShare,
  revokeShare,
  shareById,
  shareByName,
  shareBySecret,
  shareSecretHash,
  type ShareRecord,
} from "./store";

/** A share as the operator API shows it: never its secret, which only its creation returns. */
export function shareJson(share: ShareRecord): Record<string, unknown> {
  return {
    name: share.name,
    scope: formatShareScope(share.scope),
    limits: share.limits,
    embed: share.embed,
    panels: share.panels,
    raw_params: share.raw_params,
    expires_at: share.expires_at,
    revoked_at: share.revoked_at,
    created_at: share.created_at,
    updated_at: share.updated_at,
  };
}

/** Where a read came from, for the use rows: the page's origin, never the viewer's address. */
export function originOf(c: Context): string | undefined {
  const origin = c.req.header("origin");
  if (origin && origin !== "null") {
    return origin;
  }
  try {
    const referer = c.req.header("referer");
    return referer ? new URL(referer).origin : undefined;
  } catch {
    return undefined;
  }
}

function presented(header: string | undefined): string | null {
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() || null : null;
}

/** The share a secret or a live ticket (#227) opens, and which one it was. */
export function shareFor(presentedValue: string | null): { share: ShareRecord; via: "secret" | "ticket" } | null {
  if (!presentedValue) {
    return null;
  }
  if (presentedValue.startsWith(ticketPrefix)) {
    const row = ticketShareRow(presentedValue);
    const share = row ? shareById(row.id) : null;
    return share ? { share, via: "ticket" } : null;
  }
  const share = shareBySecret(presentedValue);
  return share ? { share, via: "secret" } : null;
}

/**
 * `/share/v1/*` (#225): a share's secret, or one of its tickets (#227), and nothing else. The
 * password, a session and the ingest token are refused here, and a refusal never asks for Basic,
 * so no prompt opens in a frame. The rate is taken per read, after the cache (#226, #227).
 */
export async function shareAuth(c: Context, next: Next): Promise<Response | void> {
  const found = shareFor(presented(c.req.header("authorization")));
  if (!found) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  c.set("share", found.share);
  c.set("shareVia", found.via);
  await next();
}

/** One read off the share's rate (#226), or the 429 to answer with. */
export function rateTurn(c: Context): Response | null {
  const share = c.get("share");
  const turn = takeRead(share.id, share.limits.reads_per_minute);
  if (turn.ok) {
    return null;
  }
  noteLimited(share.name, originOf(c));
  return c.json({ error: "Too many reads" }, 429, { "retry-after": String(turn.retryAfter) });
}

/** `POST /share/v1/tickets` — the host's backend trades the secret for a ticket a page can hold. */
export async function ticketRoute(c: Context): Promise<Response> {
  if (c.get("shareVia") !== "secret") {
    return c.json({ error: "a ticket is minted with the share's secret, not another ticket" }, 403);
  }
  const limited = rateTurn(c);
  if (limited) {
    return limited;
  }
  const share = c.get("share");
  const hash = shareSecretHash(share.id);
  if (!hash) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  // A ticket never outlives its share.
  const minted = mintTicket(share, hash, share.embed.ticket_ttl);
  noteRead(share.name, originOf(c));
  return c.json({ ticket: minted.ticket, expires_at: Math.min(minted.expires_at, share.expires_at) });
}

export type ShareUse = { last_read_at: string | null; reads_24h: number; refused_24h: number };

/** Each share's last 24 hours, from its use rows (#226) and the minute not yet written. */
async function shareUse(): Promise<Map<string, ShareUse>> {
  const rows = await clickhouseQuery<{ share: string; reads: string | number; refused: string | number; last: string | null }>(
    `
    SELECT
      attr_map['share'] AS share,
      sum(toUInt64OrZero(attr_map['reads']) + toUInt64OrZero(attr_map['cached'])) AS reads,
      sum(toUInt64OrZero(attr_map['refused'])) AS refused,
      maxIf(ts, toUInt64OrZero(attr_map['reads']) + toUInt64OrZero(attr_map['cached']) > 0) AS last
    FROM logs
    WHERE tenant_id = 'default' AND service = 'toposcope' AND ts >= now64(3) - INTERVAL 1 DAY
      AND attr_map['status'] = 'used' AND attr_map['share'] != ''
    GROUP BY share
  `,
    {},
  );
  const out = new Map<string, ShareUse>();
  for (const row of rows) {
    const reads = Number(row.reads);
    out.set(String(row.share), {
      last_read_at: reads > 0 && row.last ? toIsoTimestamp(String(row.last)) : null,
      reads_24h: reads,
      refused_24h: Number(row.refused),
    });
  }
  for (const [name, t] of pendingUse()) {
    const prev = out.get(name) ?? { last_read_at: null, reads_24h: 0, refused_24h: 0 };
    out.set(name, {
      last_read_at: t.last_read_at ?? prev.last_read_at,
      reads_24h: prev.reads_24h + t.reads,
      refused_24h: prev.refused_24h + t.refused,
    });
  }
  return out;
}

/** `GET /api/shares` — every share, live ones first, revoked ones kept so the list can say so. */
export async function listSharesRoute(c: Context): Promise<Response> {
  // The list still answers when ClickHouse does not; it just cannot say how a share was used.
  const use = await shareUse().catch(() => new Map<string, ShareUse>());
  return c.json({
    shares: listShares().map((share) => ({
      ...shareJson(share),
      use: use.get(share.name) ?? { last_read_at: null, reads_24h: 0, refused_24h: 0 },
    })),
  });
}

async function shareBody(c: Context): Promise<Record<string, unknown> | null> {
  const body = (await c.req.json().catch(() => null)) as unknown;
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

function writeShare(c: Context, name: string | null, body: Record<string, unknown>): Response {
  if (!name) {
    return c.json({ error: "name: lower-case letters, digits, . _ -, up to 64" }, 400);
  }
  // Named panels (#266): the fence is derived from them unless a scope is given, which must cover them.
  const panels = body.panels === undefined ? undefined : parseSharePanels(body.panels);
  if (panels && "error" in panels) {
    return c.json({ error: panels.error }, 400);
  }
  const liveNow = shareByName(name);
  const keepNow = liveNow && liveNow.revoked_at === null ? liveNow : null;
  const panelList = panels ?? keepNow?.panels ?? [];
  let scope: ShareScope | { error: string };
  if (body.scope !== undefined) {
    scope = parseShareScope(body.scope);
    if (!("error" in scope) && panelList.length) {
      const gaps = scopeGaps(scope, panelList);
      if (gaps.length) {
        return c.json({ error: `the scope does not cover the panels: ${gaps.join("; ")}`, gaps }, 400);
      }
    }
  } else if (panelList.length) {
    const logs = typeof body.logs === "string" && body.logs.trim() ? body.logs.trim() : (keepNow?.scope.logs ?? null);
    scope = deriveShareScope(panelList, logs);
  } else {
    scope = parseShareScope(body.scope);
  }
  if ("error" in scope) {
    return c.json({ error: scope.error }, 400);
  }
  if (body.raw_params !== undefined && typeof body.raw_params !== "boolean") {
    return c.json({ error: "raw_params is true or false" }, 400);
  }
  const expires = parseShareExpiry(body.expires_at);
  if (typeof expires !== "number") {
    return c.json({ error: expires.error }, 400);
  }
  // A field left out keeps what the live share has, or takes its default.
  const live = shareByName(name);
  const keep = live && live.revoked_at === null ? live : null;
  const limits = parseShareLimits(body.limits, keep?.limits);
  if ("error" in limits) {
    return c.json({ error: limits.error }, 400);
  }
  const embed = parseShareEmbed(body.embed, keep?.embed);
  if ("error" in embed) {
    return c.json({ error: embed.error }, 400);
  }
  const { share, secret, created } = putShare({
    name,
    scope,
    limits,
    embed,
    ...(panels ? { panels } : {}),
    ...(typeof body.raw_params === "boolean" ? { raw_params: body.raw_params } : {}),
    expires_at: expires,
  });
  dropShareCache(share.id);
  return c.json({ share: shareJson(share), ...(secret ? { secret } : {}) }, created ? 201 : 200);
}

/** `POST /api/shares` — a new share; its secret is in this answer and never again. */
export async function createShareRoute(c: Context): Promise<Response> {
  const body = await shareBody(c);
  if (!body) {
    return c.json({ error: "Expected an object" }, 400);
  }
  const name = parseShareName(body.name);
  const live = name ? shareByName(name) : null;
  if (live && live.revoked_at === null) {
    return c.json({ error: `a share named ${name} exists; PUT /api/shares/${name} changes it` }, 409);
  }
  return writeShare(c, name, body);
}

/** `PUT /api/shares/:name` — create or change in place, so a script can apply a share from a file. */
export async function putShareRoute(c: Context): Promise<Response> {
  const body = await shareBody(c);
  if (!body) {
    return c.json({ error: "Expected an object" }, 400);
  }
  return writeShare(c, parseShareName(c.req.param("name")), body);
}

/**
 * `POST /api/shares/:name/ticket` — signed in: a five-minute ticket for the Share dialog's live
 * preview (#236, 24d), so the panel shows through the share as the other site will see it.
 */
export async function previewTicketRoute(c: Context): Promise<Response> {
  const name = parseShareName(c.req.param("name"));
  const share = name ? shareByName(name) : null;
  if (!share || share.revoked_at !== null || share.expires_at <= Date.now()) {
    return c.json({ error: "Not found" }, 404);
  }
  const hash = shareSecretHash(share.id);
  if (!hash) {
    return c.json({ error: "Not found" }, 404);
  }
  const minted = mintTicket(share, hash, "5m");
  return c.json({ ticket: minted.ticket, expires_at: Math.min(minted.expires_at, share.expires_at) });
}

/** `DELETE /api/shares/:name` — revoke now: its secret and every read made with it stop. */
export async function revokeShareRoute(c: Context): Promise<Response> {
  const name = parseShareName(c.req.param("name"));
  const share = name ? revokeShare(name) : null;
  if (share) {
    dropShareCache(share.id);
  }
  return share ? c.json({ share: shareJson(share) }) : c.json({ error: "Not found" }, 404);
}
