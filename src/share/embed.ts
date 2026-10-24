import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import type { Database } from "bun:sqlite";
import { getDb } from "../control/index";
import { durationMs } from "./limits";

/**
 * Embedding a share's panel (#227). The page holds a ticket, never the secret: the host's backend
 * trades the secret for one at `POST /share/v1/tickets`. A ticket reads, mints nothing, and dies
 * with its share.
 */

export type ShareEmbed = {
  /** Origins that may frame the share's panels: exact, no paths, no `*`. Empty: JSON only. */
  frame_ancestors: string[];
  /** How long a ticket lasts. */
  ticket_ttl: string;
};

export const defaultShareEmbed: ShareEmbed = { frame_ancestors: [], ticket_ttl: "1h" };
export const maxFrameAncestors = 8;
const maxTicketMs = 24 * 3_600_000;
export const ticketPrefix = "tst1_";

/** `https://admin.example.com` or `http://localhost:3000`: an origin, nothing more. */
export function parseOrigin(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.includes("*")) {
    return null;
  }
  try {
    const url = new URL(raw.trim());
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
      return null;
    }
    if (url.pathname !== "/" || url.search || url.hash || raw.trim().replace(/\/$/, "") !== url.origin) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function parseShareEmbed(raw: unknown, base: ShareEmbed = defaultShareEmbed): ShareEmbed | { error: string } {
  if (raw === undefined || raw === null) {
    return base;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "embed is an object" };
  }
  const rec = raw as Record<string, unknown>;
  const out = { ...base };
  if (rec.frame_ancestors !== undefined) {
    const items = typeof rec.frame_ancestors === "string" ? rec.frame_ancestors.split(/[\s,]+/).filter(Boolean) : rec.frame_ancestors;
    if (!Array.isArray(items)) {
      return { error: "embed.frame_ancestors is a list of origins" };
    }
    const origins: string[] = [];
    for (const item of items) {
      const origin = parseOrigin(item);
      if (!origin) {
        return { error: `embed.frame_ancestors: "${String(item)}" is not an origin (https://host[:port], no *)` };
      }
      if (!origins.includes(origin)) {
        origins.push(origin);
      }
    }
    if (origins.length > maxFrameAncestors) {
      return { error: `embed.frame_ancestors holds at most ${maxFrameAncestors} origins` };
    }
    out.frame_ancestors = origins;
  }
  if (rec.ticket_ttl !== undefined) {
    const ms = typeof rec.ticket_ttl === "string" ? durationMs(rec.ticket_ttl) : null;
    if (ms === null || ms > maxTicketMs) {
      return { error: "embed.ticket_ttl is a duration up to 24h (15m, 1h)" };
    }
    out.ticket_ttl = (rec.ticket_ttl as string).trim();
  }
  return out;
}

function sign(id: string, until: number, key: string): string {
  return createHmac("sha256", key).update(`${id}.${until}`).digest("base64url").slice(0, 32);
}

/** A ticket for a share: its id, when it stops, and a signature keyed by the share's own secret hash. */
export function mintTicket(share: { id: string }, secretHash: string, ttl: string, now = Date.now()): { ticket: string; expires_at: number } {
  const until = now + (durationMs(ttl) ?? 3_600_000);
  return { ticket: `${ticketPrefix}${share.id}.${until}.${sign(share.id, until, secretHash)}`, expires_at: until };
}

/** The share id a ticket names, read without checking it: for the frame rules of an expired one. */
export function ticketShareId(ticket: string): string | null {
  if (!ticket.startsWith(ticketPrefix)) {
    return null;
  }
  const id = ticket.slice(ticketPrefix.length).split(".")[0] ?? "";
  return /^[0-9a-f-]{36}$/.test(id) ? id : null;
}

/** The share a live ticket opens, by id, or null: forged, expired, or its share revoked or expired. */
export function ticketShareRow(
  ticket: string,
  now = Date.now(),
  db: Database = getDb(),
): { id: string; secret_hash: string } | null {
  const parts = ticket.startsWith(ticketPrefix) ? ticket.slice(ticketPrefix.length).split(".") : [];
  if (parts.length !== 3) {
    return null;
  }
  const [id, untilRaw, sig] = parts as [string, string, string];
  const until = Number(untilRaw);
  if (!Number.isSafeInteger(until) || until <= now) {
    return null;
  }
  const row = db
    .query("SELECT id, secret_hash FROM shares WHERE id = ? AND revoked_at IS NULL AND expires_at > ?")
    .get(id, now) as { id: string; secret_hash: string } | null;
  if (!row) {
    return null;
  }
  const want = Buffer.from(sign(id, until, row.secret_hash));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got) ? row : null;
}

/**
 * The frame rules for `/embed`: the share's own origins, and Toposcope itself, whose Share dialog
 * shows the panel as the other site will (#236).
 */
export function embedFrameHeaders(frameAncestors: readonly string[]): Record<string, string> {
  return {
    "content-security-policy": `frame-ancestors 'self'${frameAncestors.length > 0 ? ` ${frameAncestors.join(" ")}` : ""}`,
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
  };
}

/** Every page but an embed: nothing frames Toposcope. */
export async function noFraming(c: Context, next: () => Promise<void>): Promise<void> {
  await next();
  if (!c.req.path.startsWith("/embed") && !c.res.headers.has("content-security-policy")) {
    c.res.headers.set("content-security-policy", "frame-ancestors 'none'");
  }
}
