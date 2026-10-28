import { linkProtocol } from "./version";
import { stampCreated, stampUpdated } from "../control/actors";
import type { Database } from "bun:sqlite";
import { getDb } from "../control/index";
import { hashSecret, type LinkKeyKind } from "./key";

/**
 * Keys this instance minted, and links (#136). A link is one instance pulling one feed from
 * another: `role` says which side this is (`pull`: rows arrive here; `serve`: rows leave), and
 * `connects` who opens the connection (`we`, or `they`: the side that pasted the key connects).
 */

export type LinkKeyRecord = {
  kid: string;
  kind: LinkKeyKind;
  q: string;
  secret_hash: string;
  /** Epoch ms; null for a single-use key. */
  until: number | null;
  uses: number;
  created_at: number;
  spent_at: number | null;
  revoked_at: number | null;
};

export type LinkRecord = {
  id: string;
  role: "pull" | "serve";
  connects: "we" | "they";
  peer_id: string;
  peer_name: string;
  peer_url: string;
  q: string;
  kid: string;
  /** The pulling side keeps the link's secret to present; the serving side keeps its hash. */
  secret: string | null;
  secret_hash: string | null;
  /** Pull: how far we have read at the source. Serve: how far they last asked from here. */
  position: number;
  settled: number;
  /** When the row at `position` arrived at the source. */
  arrived_at: string | null;
  /** Rows unread at the source, known only on an every-row link. */
  behind_rows: number | null;
  /** A hole: positions retention passed at the source before they were read. */
  gone_from: number | null;
  gone_to: number | null;
  /** The hole in time (#139): where reading had reached, and the start of the oldest day the source kept. */
  gone_from_at: string | null;
  gone_to_at: string | null;
  last_contact_at: number | null;
  last_error: string | null;
  created_at: number;
  removed_at: number | null;
};

export function saveLinkKey(
  key: { kid: string; kind: LinkKeyKind; q: string; secret: string; until: number | null },
  now = Date.now(),
  db: Database = getDb(),
): void {
  db.query(
    "INSERT INTO link_keys (kid, kind, q, secret_hash, until, uses, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
  ).run(key.kid, key.kind, key.q, hashSecret(key.secret), key.until, now);
  stampCreated("link_keys", key.kid, db);
}

export function getLinkKey(kid: string, db: Database = getDb()): LinkKeyRecord | null {
  return (db.query("SELECT * FROM link_keys WHERE kid = ?").get(kid) as LinkKeyRecord | undefined) ?? null;
}

export function kidTaken(kid: string, db: Database = getDb()): boolean {
  return getLinkKey(kid, db) !== null;
}

export type KeyState = "unused" | "used" | "expired" | "revoked";

/** Where a key stands, from its minter's record: what a paste's lookup is told. */
export function keyState(key: LinkKeyRecord, now = Date.now()): KeyState {
  if (key.revoked_at !== null) {
    return "revoked";
  }
  if (key.until !== null && now > key.until) {
    return "expired";
  }
  if (key.until === null && key.spent_at !== null) {
    return "used";
  }
  return "unused";
}

/** A paste took the key: a single-use key is spent, a reusable one counts one more use. */
export function useLinkKey(kid: string, now = Date.now(), db: Database = getDb()): void {
  db.query(
    "UPDATE link_keys SET uses = uses + 1, spent_at = CASE WHEN until IS NULL THEN ? ELSE spent_at END WHERE kid = ?",
  ).run(now, kid);
}

export function revokeLinkKey(kid: string, now = Date.now(), db: Database = getDb()): boolean {
  return db.query("UPDATE link_keys SET revoked_at = ? WHERE kid = ? AND revoked_at IS NULL").run(now, kid).changes > 0;
}

/** Keys still worth listing: not revoked, not past their date, single-use ones not yet pasted. */
export function openLinkKeys(now = Date.now(), db: Database = getDb()): LinkKeyRecord[] {
  return (db.query("SELECT * FROM link_keys ORDER BY created_at").all() as LinkKeyRecord[]).filter(
    (key) => keyState(key, now) === "unused",
  );
}

export function linkId(): string {
  return `l_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export function saveLink(
  link: Omit<
    LinkRecord,
    "position" | "settled" | "arrived_at" | "behind_rows" | "gone_from" | "gone_to" | "gone_from_at" | "gone_to_at" | "last_contact_at" | "last_error" | "removed_at"
  >,
  db: Database = getDb(),
): LinkRecord {
  db.query(
    `INSERT INTO links (id, role, connects, peer_id, peer_name, peer_url, q, kid, secret, secret_hash, created_at, protocol)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${linkProtocol})`,
  ).run(
    link.id,
    link.role,
    link.connects,
    link.peer_id,
    link.peer_name,
    link.peer_url,
    link.q,
    link.kid,
    link.secret,
    link.secret_hash,
    link.created_at,
  );
  stampCreated("links", link.id, db);
  return getLink(link.id, db)!;
}

export function getLink(id: string, db: Database = getDb()): LinkRecord | null {
  return (db.query("SELECT * FROM links WHERE id = ?").get(id) as LinkRecord | undefined) ?? null;
}

export function linkBySecret(secret: string, db: Database = getDb()): LinkRecord | null {
  return (
    (db
      .query("SELECT * FROM links WHERE secret_hash = ? AND removed_at IS NULL")
      .get(hashSecret(secret)) as LinkRecord | undefined) ?? null
  );
}

export function activeLinks(db: Database = getDb()): LinkRecord[] {
  return db.query("SELECT * FROM links WHERE removed_at IS NULL ORDER BY created_at").all() as LinkRecord[];
}

export function removeLink(id: string, now = Date.now(), db: Database = getDb()): LinkRecord | null {
  db.query("UPDATE links SET removed_at = ? WHERE id = ? AND removed_at IS NULL").run(now, id);
  stampUpdated("links", id, db);
  return getLink(id, db);
}

export function noteContact(
  id: string,
  fields: Partial<
    Pick<
      LinkRecord,
      "position" | "settled" | "arrived_at" | "behind_rows" | "gone_from" | "gone_to" | "gone_from_at" | "gone_to_at" | "last_error" | "peer_name"
    >
  > & { at: number },
  db: Database = getDb(),
): void {
  const sets: string[] = ["last_contact_at = ?"];
  const values: (string | number | null)[] = [fields.at];
  const keys = [
    "position", "settled", "arrived_at", "behind_rows", "gone_from", "gone_to", "gone_from_at", "gone_to_at", "last_error", "peer_name",
  ] as const;
  for (const key of keys) {
    if (key in fields) {
      sets.push(`${key} = ?`);
      values.push((fields[key] ?? null) as string | number | null);
    }
  }
  values.push(id);
  db.query(`UPDATE links SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

/** A failed call: last contact stays where it was, so the list can say since when. */
export function noteFailure(id: string, error: string, db: Database = getDb()): void {
  db.query("UPDATE links SET last_error = ? WHERE id = ?").run(error.slice(0, 300), id);
}

/**
 * A hole's ends in time (#139), when a reply says retention passed positions before they were
 * read. The near end is where this link's rows were known to: its last contact if it was caught
 * up then, else the arrival time it had read to. The far end is the start of the oldest day the
 * source keeps, from its horizon. A hole only grows.
 */
export function holeTimes(
  link: Pick<LinkRecord, "position" | "settled" | "arrived_at" | "last_contact_at" | "created_at" | "gone_from_at" | "gone_to_at">,
  reply: { gone: { from: number; to: number } | null; horizon: string },
): Pick<LinkRecord, "gone_from_at" | "gone_to_at"> {
  if (!reply.gone) {
    return { gone_from_at: link.gone_from_at, gone_to_at: link.gone_to_at };
  }
  const known =
    link.last_contact_at !== null && link.position >= link.settled
      ? new Date(link.last_contact_at).toISOString()
      : (link.arrived_at ?? new Date(link.created_at).toISOString());
  const horizon = new Date(reply.horizon);
  const day = new Date(Date.UTC(horizon.getUTCFullYear(), horizon.getUTCMonth(), horizon.getUTCDate())).toISOString();
  const from = link.gone_from_at && link.gone_from_at < known ? link.gone_from_at : known;
  const kept = link.gone_to_at && link.gone_to_at > day ? link.gone_to_at : day;
  // Never closed before it opens: positions can go before their day is past retention.
  const to = kept < from ? from : kept;
  return { gone_from_at: from, gone_to_at: to };
}
