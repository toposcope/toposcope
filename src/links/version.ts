import type { Context } from "hono";
import { version } from "../shared/version";

/**
 * What both sides of a link must share (#328). The protocol is how instances talk under
 * `/link/v1/`; the schema is the shape of every table a link carries, bumped whenever one changes,
 * since rows travel as those tables store them. Different versions never store a row: the link
 * stops where it stands and says which side to upgrade.
 */
export const linkProtocol = 2;
export const linkSchema = 1;

export type LinkVersions = { protocol: number; schema: number; version: string };

export const here = (): LinkVersions => ({ protocol: linkProtocol, schema: linkSchema, version });

/** Sent on every contact, both ways. */
export function versionHeaders(): Record<string, string> {
  return {
    "x-toposcope-link": String(linkProtocol),
    "x-toposcope-schema": String(linkSchema),
    "x-toposcope-version": version,
  };
}

export function versionsOf(headers: { get(name: string): string | null | undefined }): LinkVersions {
  return {
    protocol: Number(headers.get("x-toposcope-link") ?? 0) || 0,
    schema: Number(headers.get("x-toposcope-schema") ?? 0) || 0,
    version: headers.get("x-toposcope-version") ?? "an older release",
  };
}

export function sameVersions(a: LinkVersions, b: LinkVersions): boolean {
  return a.protocol === b.protocol && a.schema === b.schema;
}

/** `0.11.2` < `0.12.0`; anything that does not parse is older. */
export function olderRelease(a: string, b: string): boolean {
  const parse = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10));
  const [pa, pb] = [parse(a), parse(b)];
  if (pa.some(Number.isNaN)) return true;
  if (pb.some(Number.isNaN)) return false;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return false;
}

/** “edge-1 is on 0.11.0, this instance on 0.12.0: upgrade edge-1.” */
export function mismatchWords(peerName: string, peer: LinkVersions, mine: LinkVersions = here()): string {
  const side = olderRelease(peer.version, mine.version)
    ? peerName
    : olderRelease(mine.version, peer.version)
      ? "this instance"
      : "both to one release";
  return `${peerName} is on ${peer.version}, this instance on ${mine.version}: upgrade ${side}.`;
}

/** A `/link/v1/` route's answer when the caller speaks another version, else null. */
export function refuseOtherVersion(c: Context): Response | null {
  const there = versionsOf({ get: (n) => c.req.header(n) });
  if (sameVersions(there, here())) {
    return null;
  }
  return c.json({ error: "versions differ", here: here(), there }, 409, versionHeaders());
}

/** Reads a 409 from the other side: its versions, when that is why it refused. */
export async function versionRefusal(res: Response): Promise<LinkVersions | null> {
  if (res.status !== 409) {
    return null;
  }
  const body = (await res.clone().json().catch(() => null)) as { error?: string; here?: LinkVersions } | null;
  return body?.error === "versions differ" && body.here ? body.here : null;
}
