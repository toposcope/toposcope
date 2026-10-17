import { instanceId } from "../control/instance";
import type { FeedReply } from "../feed/feed";
import { insertPulled } from "../ingest/pulled";
import { activeLinks, getLink, noteContact, noteFailure, type LinkRecord } from "./store";

/**
 * The pull loop (#136), inside the app like the alert checker. For each link this instance pulls
 * and calls out for, it asks the source for what arrived after where it stands, stores the rows
 * as they came, and keeps its position. The source's own store is the buffer: a pull that fails
 * is asked again next time, from the same position.
 */
export const pullEveryMs = 5_000;
/** Pages read from one source in one pass, so one busy source does not hold the others. */
export const pullPagesPerPass = 20;
export const pullPageRows = 1_000;

type FeedFromSource = FeedReply & { source?: { id: string; name: string } };

export type PullDeps = {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  hereId: () => string;
  now: () => number;
};

const defaultDeps: PullDeps = { fetch: (url, init) => fetch(url, init), hereId: () => instanceId(), now: () => Date.now() };

function failureWords(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.slice(0, 200) || "no answer";
}

export async function pullLink(link: LinkRecord, deps: PullDeps = defaultDeps): Promise<{ stored: number }> {
  let after = link.position;
  let stored = 0;
  let gone: { from: number; to: number } | null =
    link.gone_from !== null && link.gone_to !== null ? { from: link.gone_from, to: link.gone_to } : null;
  let arrived = link.arrived_at;
  for (let page = 0; page < pullPagesPerPass; page++) {
    let reply: FeedFromSource;
    try {
      const res = await deps.fetch(
        `${link.peer_url.replace(/\/+$/, "")}/link/v1/feed?after=${after}&limit=${pullPageRows}`,
        { headers: { authorization: `Bearer ${link.secret ?? ""}` }, signal: AbortSignal.timeout(15_000) },
      );
      if (res.status === 401) {
        noteFailure(link.id, "refused: the link was removed at the source");
        return { stored };
      }
      if (!res.ok) {
        noteFailure(link.id, `the source answered ${res.status}`);
        return { stored };
      }
      reply = (await res.json()) as FeedFromSource;
    } catch (err) {
      noteFailure(link.id, failureWords(err));
      return { stored };
    }
    if (reply.refused) {
      noteFailure(link.id, reply.refused);
      return { stored };
    }
    const result = await insertPulled(reply.rows, { name: reply.source?.name || link.peer_name }, deps.hereId());
    stored += result.stored;
    after = reply.through;
    if (reply.gone) {
      // A hole never closes: it only grows if retention passes more before it is read.
      gone = gone
        ? { from: Math.min(gone.from, reply.gone.from), to: Math.max(gone.to, reply.gone.to) }
        : reply.gone;
    }
    arrived = reply.arrived ?? arrived;
    noteContact(link.id, {
      at: deps.now(),
      position: after,
      settled: reply.settled,
      arrived_at: arrived,
      // Exact only on an every-row link: on a filtered one we know positions, not matches.
      behind_rows: link.q.trim() === "" ? Math.max(0, reply.settled - after) : null,
      gone_from: gone?.from ?? null,
      gone_to: gone?.to ?? null,
      peer_name: reply.source?.name || link.peer_name,
      last_error: null,
    });
    if (reply.through >= reply.settled) {
      break;
    }
  }
  return { stored };
}

let running = false;
let timer: ReturnType<typeof setInterval> | null = null;

/** One pass over every link this instance pulls and calls out for. Passes never overlap. */
export async function pullPass(deps: PullDeps = defaultDeps): Promise<void> {
  if (running) {
    return;
  }
  running = true;
  try {
    for (const link of activeLinks()) {
      if (link.role === "pull" && link.connects === "we") {
        await pullLink(link, deps);
      }
    }
  } finally {
    running = false;
  }
}

/** Start pulling at once for a link just made, without waiting for the next pass. */
export function pullSoon(id: string): void {
  const link = getLink(id);
  if (link && link.role === "pull" && link.connects === "we") {
    void pullLink(link).catch((err) => console.error("pull failed", err));
  }
}

export function startLinkPuller(): void {
  if (timer) {
    return;
  }
  timer = setInterval(() => {
    void pullPass().catch((err) => console.error("pull pass failed", err));
  }, pullEveryMs);
  // The server keeps the process alive; the loop alone should not.
  timer.unref?.();
}

export function stopLinkPuller(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
