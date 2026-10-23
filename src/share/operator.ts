import type { Context, Next } from "hono";
import { formatShareScope, parseShareScope } from "./scope";
import {
  listShares,
  parseShareExpiry,
  parseShareName,
  putShare,
  revokeShare,
  shareByName,
  shareBySecret,
  type ShareRecord,
} from "./store";

/** A share as the operator API shows it: never its secret, which only its creation returns. */
export function shareJson(share: ShareRecord): Record<string, unknown> {
  return {
    name: share.name,
    scope: formatShareScope(share.scope),
    expires_at: share.expires_at,
    revoked_at: share.revoked_at,
    created_at: share.created_at,
    updated_at: share.updated_at,
  };
}

function presented(header: string | undefined): string | null {
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() || null : null;
}

/**
 * `/share/v1/*` (#225): a share's secret and nothing else. The password, a session and the ingest
 * token are refused here, and a refusal never asks for Basic, so no prompt opens in a frame.
 */
export async function shareAuth(c: Context, next: Next): Promise<Response | void> {
  const secret = presented(c.req.header("authorization"));
  const share = secret ? shareBySecret(secret) : null;
  if (!share) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  c.set("share", share);
  await next();
}

/** `GET /api/shares` — every share, live ones first, revoked ones kept so the list can say so. */
export async function listSharesRoute(c: Context): Promise<Response> {
  return c.json({ shares: listShares().map(shareJson) });
}

async function shareBody(c: Context): Promise<Record<string, unknown> | null> {
  const body = (await c.req.json().catch(() => null)) as unknown;
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

function writeShare(c: Context, name: string | null, body: Record<string, unknown>): Response {
  if (!name) {
    return c.json({ error: "name: lower-case letters, digits, . _ -, up to 64" }, 400);
  }
  const scope = parseShareScope(body.scope);
  if ("error" in scope) {
    return c.json({ error: scope.error }, 400);
  }
  const expires = parseShareExpiry(body.expires_at);
  if (typeof expires !== "number") {
    return c.json({ error: expires.error }, 400);
  }
  const { share, secret, created } = putShare({ name, scope, expires_at: expires });
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

/** `DELETE /api/shares/:name` — revoke now: its secret and every read made with it stop. */
export async function revokeShareRoute(c: Context): Promise<Response> {
  const name = parseShareName(c.req.param("name"));
  const share = name ? revokeShare(name) : null;
  return share ? c.json({ share: shareJson(share) }) : c.json({ error: "Not found" }, 404);
}
