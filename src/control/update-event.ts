import type { Database } from "bun:sqlite";
import type { LogEvent } from "../shared/log-event";
import { getDb } from "./index";
import { compileQuery, type QueryNode } from "../query/compile";
import { version as runningVersion } from "../shared/version";
import { releaseStep, type Release } from "./release-check";

/**
 * A new release can page someone (#197). The first time the release check sees a version newer
 * than the running one, Toposcope writes one log row for it, `service:toposcope
 * event:update_available`, through ordinary ingest; an operator pages on it with an ordinary
 * monitor. Once per version: a version already announced is never announced again, after a
 * restart either. Several out at once: the row names the newest and how many lie between.
 */

const announcedKey = "update_announced";

export type AnnounceDeps = {
  db?: Database;
  write: (rows: LogEvent[]) => Promise<unknown>;
  now?: () => number;
};

export function lastAnnounced(db: Database = getDb()): string | null {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(announcedKey) as { value: string } | null;
  return row?.value ?? null;
}

/** The row for the newest of `releases`, or null when there is nothing newer, or it was said already. */
export function updateRow(releases: Release[], running: string, announced: string | null, at: number): LogEvent | null {
  const latest = releases[0];
  if (!latest || latest.version === announced || releaseStep(announced ?? running, latest.version) === null) {
    return null;
  }
  const step = releaseStep(running, latest.version);
  if (step === null) {
    return null;
  }
  return {
    ts: new Date(at).toISOString(),
    service: "toposcope",
    level: "info",
    message: `Toposcope ${latest.version} is out; this instance runs ${running} (${step})`,
    attrs: {
      event: "update_available",
      running,
      latest: latest.version,
      step,
      behind: releases.length,
      ...(latest.url ? { url: latest.url } : {}),
    },
  };
}

/**
 * After a check that got an answer: write the row, then remember the version, so a row that
 * could not be stored is tried again on the next check rather than lost.
 */
export async function announceNewRelease(releases: Release[], running: string, deps: AnnounceDeps): Promise<boolean> {
  const db = deps.db ?? getDb();
  const row = updateRow(releases, running, lastAnnounced(db), (deps.now ?? Date.now)());
  if (!row) {
    return false;
  }
  await deps.write([row]);
  db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    announcedKey,
    String(row.attrs!.latest),
  );
  return true;
}

/** True when every line this node can match has `event:update_available`. */
function onlyUpdateRows(node: QueryNode | null): boolean {
  if (!node) {
    return false;
  }
  if (node.op === "and") {
    return onlyUpdateRows(node.a) || onlyUpdateRows(node.b);
  }
  if (node.op === "or") {
    return onlyUpdateRows(node.a) && onlyUpdateRows(node.b);
  }
  return node.op === "kv" && node.key === "event" && node.value === "update_available" && !node.glob;
}

/**
 * What a monitor reads for a query on the update rows: only those written by the version running
 * now. A row from before an upgrade says a version is out that this instance may already run, so
 * it neither opens a monitor nor holds one open. Any other query is read as it is.
 */
export function forRunningVersion(query: string, running: string = runningVersion): string {
  try {
    const compiled = compileQuery(query);
    return compiled.faults.length === 0 && onlyUpdateRows(compiled.ast) ? `(${query}) running:${running}` : query;
  } catch {
    return query;
  }
}
