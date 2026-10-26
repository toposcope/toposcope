import { timingSafeEqual } from "node:crypto";
import { hashToken, noteTokenUsedAt, tokenByHash } from "./control/tokens";
import { noteAccessUsed } from "./access/use";

/** The `.env` ingest token has no record; Access lists it under this name. */
export const envIngestTokenName = "TOPOSCOPE_INGEST_TOKEN";
import { envValue } from "./shared/env";
import { instanceId, instanceName } from "./control/instance";

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

export function ingestToken(): string | undefined {
  return envValue("TOPOSCOPE_INGEST_TOKEN");
}

export function basicPassword(): string | undefined {
  return envValue("TOPOSCOPE_PASSWORD");
}

export function checkBearer(header: string | undefined): boolean {
  const presented = bearerToken(header);
  if (!presented) {
    return false;
  }
  const token = ingestToken();
  if (token && safeEqual(presented, token)) {
    noteAccessUsed("token", envIngestTokenName);
    return true;
  }
  try {
    const found = tokenByHash(hashToken(presented));
    if (found) {
      noteAccessUsed("token", found.name);
      noteTokenUsedAt(found.id);
    }
    return found !== null;
  } catch {
    return false;
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

export function checkBasic(header: string | undefined): boolean {
  const password = basicPassword();
  if (!password || !header) {
    return false;
  }
  const prefix = "Basic ";
  if (!header.startsWith(prefix)) {
    return false;
  }
  let decoded: string;
  try {
    decoded = atob(header.slice(prefix.length));
  } catch {
    return false;
  }
  const colon = decoded.indexOf(":");
  if (colon < 0) {
    return false;
  }
  return safeEqual(decoded.slice(colon + 1), password);
}

/** `toposcope · <name>`, so two instances on one machine ask in their own words (#102). */
export function basicRealm(): string {
  let name: string | null = null;
  try {
    name = instanceName();
  } catch {
    name = null;
  }
  // A header value is Latin-1, and the realm is quoted.
  const safe = (name ?? "").replace(/[^\x20-\x7e\xa0-\xff]|["\\]/g, "").trim();
  return safe ? `toposcope · ${safe}` : "toposcope";
}

export function unauthorizedHeaders(): Record<string, string> {
  return { "WWW-Authenticate": `Basic realm="${basicRealm()}"` };
}

export function passwordMatches(presented: string): boolean {
  const password = basicPassword();
  return Boolean(password) && safeEqual(presented, password!);
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
