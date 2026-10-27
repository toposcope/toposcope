import { hashToken, noteTokenUsedAt, tokenByHash } from "./control/tokens";
import { noteAccessUsed } from "./access/use";

import { instanceId } from "./control/instance";
import { isPersonTokenShape, sessionPerson, tokenActor, type Actor } from "./control/people";


export function checkBearer(header: string | undefined): boolean {
  return ingestTokenName(header) !== null;
}

/** The ingest token a bearer header holds, by name (its use counted), or null. */
export function ingestTokenName(header: string | undefined): string | null {
  const presented = bearerToken(header);
  if (!presented) {
    return null;
  }
  try {
    const found = tokenByHash(hashToken(presented));
    if (found) {
      noteAccessUsed("token", found.name);
      noteTokenUsedAt(found.id);
      return found.name;
    }
    return null;
  } catch {
    return null;
  }
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) {
    return undefined;
  }
  const presented = header.slice(prefix.length);
  return presented.length > 0 ? presented : undefined;
}

/**
 * A request's person (#305): a browser session cookie, or `Authorization: Bearer` with a personal
 * or service account token. There is no shared password and no Basic auth.
 */
export function resolveActor(authorization: string | undefined, cookieHeader: string | undefined, now = Date.now()): Actor | null {
  const presented = bearerToken(authorization);
  if (presented && isPersonTokenShape(presented)) {
    return tokenActor(presented, now);
  }
  const session = sessionPerson(readCookie(cookieHeader, sessionCookieName()), now);
  if (!session) {
    return null;
  }
  return { person: session.person, via: "session", token: null, role: session.person.role };
}

/** The session's end, for `GET /api/instance`, or null when the request came with a token. */
export function sessionEnd(cookieHeader: string | undefined, now = Date.now()): number | null {
  return sessionPerson(readCookie(cookieHeader, sessionCookieName()), now)?.expiresAt ?? null;
}

export function isBasic(authorization: string | undefined): boolean {
  return Boolean(authorization?.startsWith("Basic "));
}

/** One cookie per instance: two on one host (different ports) do not sign each other out. */
export function sessionCookieName(): string {
  return `toposcope_session_${instanceId().replace(/-/g, "").slice(0, 8)}`;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

export function sessionCookieHeader(value: string, maxAgeSeconds: number, secure: boolean): string {
  return `${sessionCookieName()}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}
