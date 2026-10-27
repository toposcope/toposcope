import { mismatchWords, versionHeaders, versionRefusal } from "./version";
import type { Context } from "hono";
import { instanceId, instanceName, parseInstanceName, writeInstanceName } from "../control/instance";
import { compileQuery } from "../query/compile";
import { setHereName } from "../shared/here";
import { publicUrl } from "../shared/public-url";
import {
  decodeLinkKey,
  encodeLinkKey,
  kidLabel,
  linkKeyMaxDays,
  linkKeyNotAKey,
  linkKeyOlder,
  newKid,
  newSecret,
  type LinkKey,
  type LinkKeyKind,
} from "./key";
import { pullSoon } from "./puller";
import {
  activeLinks,
  getLink,
  kidTaken,
  linkId,
  openLinkKeys,
  removeLink,
  revokeLinkKey,
  saveLink,
  saveLinkKey,
  type LinkRecord,
} from "./store";

/** The Links view's routes (#136), behind the operator password. */

export type LinkView = Omit<LinkRecord, "secret" | "secret_hash">;

export type LinkKeyView = {
  kid: string;
  label: string;
  kind: LinkKeyKind;
  q: string;
  until: number | null;
  uses: number;
  created_at: number;
};

function view(link: LinkRecord): LinkView {
  const { secret: _s, secret_hash: _h, ...rest } = link;
  return rest;
}

/** The address the other side is told to reach this instance at. */
function addressOf(c: Context): string {
  const configured = publicUrl();
  if (configured) {
    return configured;
  }
  const host = (c.req.header("x-forwarded-host") ?? c.req.header("host") ?? "").split(",")[0]!.trim();
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() || new URL(c.req.url).protocol.replace(":", "");
  return `${proto}://${host}`;
}

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Minting and pasting ask for this instance's name the first time, above everything else; the
 * other side sees it. After that it lives in Settings.
 */
function ensureName(body: Record<string, unknown>): string | { error: string; needs_name: true } {
  const existing = instanceName();
  if (existing) {
    return existing;
  }
  const parsed = parseInstanceName(body.name ?? null);
  if (parsed === null || typeof parsed !== "string") {
    return {
      error: parsed && typeof parsed === "object" ? parsed.error : "Name this instance first: the other side sees this name.",
      needs_name: true,
    };
  }
  const saved = writeInstanceName(parsed);
  setHereName(saved);
  return saved ?? parsed;
}

export function listLinksRoute(c: Context): Response {
  const keys: LinkKeyView[] = openLinkKeys().map((key) => ({
    kid: key.kid,
    label: kidLabel(key.kid),
    kind: key.kind,
    q: key.q,
    until: key.until,
    uses: key.uses,
    created_at: key.created_at,
  }));
  return c.json({ here: { id: instanceId(), name: instanceName() }, links: activeLinks().map(view), keys });
}

async function mint(c: Context, kind: LinkKeyKind): Promise<Response> {
  const body = await jsonBody(c);
  const name = ensureName(body);
  if (typeof name !== "string") {
    return c.json(name, 409);
  }
  const q = typeof body.q === "string" ? body.q.trim() : "";
  const compiled = compileQuery(q);
  if (compiled.faults.length > 0) {
    return c.json({ error: compiled.faults[0]?.msg ?? "q does not compile", faults: compiled.faults }, 400);
  }
  // An offer works once. An invite works once, or for many until a date, 30 days at most.
  let until: number | null = null;
  if (kind === "invite" && body.until !== undefined && body.until !== null) {
    const ms = Number(body.until);
    const now = Date.now();
    if (!Number.isSafeInteger(ms) || ms <= now) {
      return c.json({ error: "until is a time in the future" }, 400);
    }
    if (ms > now + linkKeyMaxDays * 86_400_000) {
      return c.json({ error: `A reusable key works ${linkKeyMaxDays} days at most` }, 400);
    }
    until = ms;
  }
  let kid = newKid();
  for (let i = 0; i < 20 && kidTaken(kid); i++) {
    kid = newKid();
  }
  const secret = newSecret();
  saveLinkKey({ kid, kind, q, secret, until });
  const key: LinkKey = { kind, name, url: addressOf(c), kid, q, until, secret };
  return c.json({ key: encodeLinkKey(key), kid, label: kidLabel(kid), kind, q, until }, 201);
}

export function offerRoute(c: Context): Promise<Response> {
  return mint(c, "offer");
}

export function inviteRoute(c: Context): Promise<Response> {
  return mint(c, "invite");
}

type Lookup = { state: string; uses: number; minted_at: number; name: string | null };

async function lookup(key: LinkKey): Promise<Lookup | null> {
  try {
    const res = await fetch(`${key.url.replace(/\/+$/, "")}/link/v1/lookup`, {
      method: "POST",
      headers: { "content-type": "application/json", ...versionHeaders() },
      body: JSON.stringify({ kid: key.kid, secret: key.secret }),
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status === 404) {
      return { state: "unknown", uses: 0, minted_at: 0, name: null };
    }
    return res.ok ? ((await res.json()) as Lookup) : null;
  } catch {
    return null;
  }
}

/**
 * The preview before confirm: who minted the key, which way rows will move and the filter, from
 * the key itself; then one lookup to the minter, since only it knows whether the key is unused.
 */
export async function previewRoute(c: Context): Promise<Response> {
  const body = await jsonBody(c);
  const decoded = decodeLinkKey(typeof body.key === "string" ? body.key : "");
  if ("error" in decoded) {
    return c.json(
      decoded.error === linkKeyOlder
        ? { error: linkKeyOlder }
        : { error: linkKeyNotAKey, detail: "Link keys start with tsl2_ and are one unbroken line. Ingest tokens are not link keys." },
      400,
    );
  }
  const { secret: _secret, ...shown } = decoded;
  const expired = decoded.until !== null && Date.now() > decoded.until;
  const found = expired ? null : await lookup(decoded);
  return c.json({
    ...shown,
    label: kidLabel(decoded.kid),
    expired,
    lookup: found,
    lookup_failed: !expired && found === null,
  });
}

/** Confirm: claim the key at its minter, swap it for the link's own secret, and start. */
export async function confirmRoute(c: Context): Promise<Response> {
  const body = await jsonBody(c);
  const decoded = decodeLinkKey(typeof body.key === "string" ? body.key : "");
  if ("error" in decoded) {
    return c.json({ error: decoded.error === linkKeyOlder ? linkKeyOlder : linkKeyNotAKey }, 400);
  }
  if (decoded.until !== null && Date.now() > decoded.until) {
    return c.json({ error: "The key has expired", state: "expired" }, 409);
  }
  const name = ensureName(body);
  if (typeof name !== "string") {
    return c.json(name, 409);
  }
  let claim: { link: string; secret: string; minter: { id: string; name: string }; q: string; kind: LinkKeyKind };
  try {
    const res = await fetch(`${decoded.url.replace(/\/+$/, "")}/link/v1/claim`, {
      method: "POST",
      headers: { "content-type": "application/json", ...versionHeaders() },
      body: JSON.stringify({ kid: decoded.kid, secret: decoded.secret, peer: { id: instanceId(), name, url: addressOf(c) } }),
      signal: AbortSignal.timeout(10_000),
    });
    const other = await versionRefusal(res);
    if (other) {
      return c.json({ error: mismatchWords(decoded.name, other), state: "versions differ" }, 409);
    }
    if (!res.ok) {
      const reason = (await res.json().catch(() => ({}))) as { error?: string; state?: string };
      return c.json({ error: reason.error ?? `${decoded.name} answered ${res.status}`, state: reason.state }, 409);
    }
    claim = await res.json();
  } catch {
    return c.json({ error: `${decoded.name} did not answer. The key may still be good.` }, 502);
  }
  const link = saveLink({
    id: linkId(),
    // An offer's minter is the source, so rows arrive here; an invite's minter pulls from here.
    role: claim.kind === "offer" ? "pull" : "serve",
    // The side that pasted connects.
    connects: "we",
    peer_id: claim.minter.id,
    peer_name: claim.minter.name || decoded.name,
    peer_url: decoded.url,
    q: claim.q,
    kid: decoded.kid,
    secret: claim.secret,
    secret_hash: null,
    created_at: Date.now(),
  });
  pullSoon(link.id);
  return c.json(view(link), 201);
}

/** Removing stops the link and deletes nothing: rows already moved age out under retention. */
export async function removeLinkRoute(c: Context): Promise<Response> {
  const link = getLink(c.req.param("id") ?? "");
  if (!link || link.removed_at !== null) {
    return c.json({ error: "no such link" }, 404);
  }
  removeLink(link.id);
  // The side that connects can tell the other at once; the other finds out on its next call.
  if (link.connects === "we" && link.secret) {
    void fetch(`${link.peer_url.replace(/\/+$/, "")}/link/v1/remove`, {
      method: "POST",
      headers: { authorization: `Bearer ${link.secret}`, ...versionHeaders() },
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined);
  }
  return c.json({ ok: true });
}

export function revokeKeyRoute(c: Context): Response {
  return revokeLinkKey(c.req.param("kid") ?? "") ? c.json({ ok: true }) : c.json({ error: "no such key" }, 404);
}
