import type { Database } from "bun:sqlite";
import type { Context } from "hono";
import { actorName, currentActorRef } from "./actors";
import { getDb } from "./index";
import { readCoverage } from "../query/coverage";
import { applyAccepted, gapShare, isGap, isGapKey, type AcceptedRow, type Coverage, type GapKey } from "../shared/coverage";

/**
 * Accepted coverage gaps (#392, frames 37n and 37o): an Operator says a service is not meant to send
 * a key, so Home, the counts and the event panel stop naming it. Each holds its share at accept;
 * it comes back when the share falls below that, and is cleared when the key reaches 90%. Every
 * accept, undo and clear is in `coverage_accepted_log` with who and when.
 */

type Row = { service: string; key: string; share: number; by_id: string | null; at: number };

export function readAccepted(db: Database = getDb()): AcceptedRow[] {
  const rows = db.query("SELECT service, key, share, by_id, at FROM coverage_accepted").all() as Row[];
  return rows.filter((r): r is Row & { key: GapKey } => isGapKey(r.key)).map((r) => ({ service: r.service, key: r.key, share: r.share, by: r.by_id, at: r.at }));
}

function log(db: Database, service: string, key: string, action: "accept" | "undo" | "clear", share: number | null, by: string | null, at: number): void {
  db.query("INSERT INTO coverage_accepted_log (service, key, action, share, by_id, by_name, at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    service,
    key,
    action,
    share,
    by,
    by ? (actorName(by, db)?.name ?? null) : null,
    at,
  );
}

export function acceptGap(service: string, key: GapKey, share: number, now = Date.now(), db: Database = getDb()): void {
  const by = currentActorRef();
  db.query(
    "INSERT INTO coverage_accepted (service, key, share, by_id, by_name, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(service, key) DO UPDATE SET share = excluded.share, by_id = excluded.by_id, by_name = excluded.by_name, at = excluded.at",
  ).run(service, key, share, by, by ? (actorName(by, db)?.name ?? null) : null, now);
  log(db, service, key, "accept", share, by, now);
}

export function undoGap(service: string, key: GapKey, now = Date.now(), db: Database = getDb()): boolean {
  const gone = db.query("DELETE FROM coverage_accepted WHERE service = ? AND key = ?").run(service, key).changes > 0;
  if (gone) {
    log(db, service, key, "undo", null, currentActorRef(), now);
  }
  return gone;
}

/** Coverage with its accepted gaps folded in; a gap whose key reached 90% is cleared here. */
export async function coverageWithAccepted(db: Database = getDb()): Promise<Coverage> {
  const raw = await readCoverage();
  const { coverage, cleared } = applyAccepted(raw, readAccepted(db));
  const now = Date.now();
  for (const r of cleared) {
    db.query("DELETE FROM coverage_accepted WHERE service = ? AND key = ?").run(r.service, r.key);
    log(db, r.service, r.key, "clear", null, null, now);
  }
  return coverage;
}

/** Names on the list: who accepted each gap, as the UI shows a stamp, and their role for the hover. */
export function withNames(c: Coverage, db: Database = getDb()): Coverage {
  return {
    ...c,
    accepted: c.accepted?.map((a) => {
      if (!a.by) {
        return a;
      }
      const stored = db.query("SELECT by_name FROM coverage_accepted WHERE service = ? AND key = ?").get(a.service, a.key) as { by_name: string | null } | null;
      const role = db.query("SELECT role FROM people WHERE id = ?").get(a.by) as { role: string } | null;
      return { ...a, by: actorName(a.by, db)?.name ?? stored?.by_name ?? a.by, ...(role ? { by_role: role.role } : {}) };
    }),
  };
}

export async function coverageRoute(c: Context): Promise<Response> {
  return c.json(withNames(await coverageWithAccepted()));
}

function readGap(rec: Record<string, unknown>): { service: string; key: GapKey } | string {
  const service = typeof rec.service === "string" ? rec.service.trim() : "";
  if (!service) {
    return "service is required";
  }
  if (!isGapKey(rec.key)) {
    return "key must be version, host, trace_id, stack or marks";
  }
  return { service, key: rec.key };
}

/** `POST /api/coverage/accepted` `{ service, key }`: accept a gap at its share now. */
export async function acceptGapRoute(c: Context): Promise<Response> {
  let rec: Record<string, unknown>;
  try {
    rec = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const gap = readGap(rec ?? {});
  if (typeof gap === "string") {
    return c.json({ error: gap }, 400);
  }
  const coverage = await coverageWithAccepted();
  const svc = coverage.services.find((s) => s.service === gap.service);
  if (!svc) {
    return c.json({ error: `No rows from ${gap.service} in the last 24 h` }, 404);
  }
  if (!isGap(svc, gap.key)) {
    return c.json({ error: `${gap.key} on ${gap.service} is not a gap: there is nothing to accept` }, 400);
  }
  acceptGap(gap.service, gap.key, gapShare(svc, gap.key) ?? 0);
  return c.json(withNames(await coverageWithAccepted()));
}

/** `DELETE /api/coverage/accepted?service=&key=`: undo an accept; the gap counts again. */
export async function undoGapRoute(c: Context): Promise<Response> {
  const gap = readGap({ service: c.req.query("service"), key: c.req.query("key") });
  if (typeof gap === "string") {
    return c.json({ error: gap }, 400);
  }
  if (!undoGap(gap.service, gap.key)) {
    return c.json({ error: "That gap is not accepted" }, 404);
  }
  return c.json(withNames(await coverageWithAccepted()));
}
