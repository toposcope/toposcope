import { timingSafeEqual } from "node:crypto";
import { hashToken, tokenHashExists } from "./control/tokens";
import { envValue } from "./shared/env";

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
    return true;
  }
  try {
    return tokenHashExists(hashToken(presented));
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

export function unauthorizedHeaders(): Record<string, string> {
  return { "WWW-Authenticate": 'Basic realm="toposcope"' };
}
