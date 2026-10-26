import { isPaused } from "./page";
import { instanceId, instanceName } from "../control/instance";

function instanceNameOrEmpty(): string {
  return instanceName() ?? "";
}
import { readFeed, type FeedReply } from "../feed/feed";
import { getRetentionDays } from "../control/settings";
import { insertPulled, insertPulledMarks } from "../ingest/pulled";
import { hereName } from "../shared/here";
import { activeLinks, getLink, holeTimes, noteContact, noteFailure, type LinkRecord } from "./store";

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
  let holeAt = { gone_from_at: link.gone_from_at, gone_to_at: link.gone_to_at };
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
    const source = { name: reply.source?.name || link.peer_name };
    const result = await insertPulled(reply.rows, source, deps.hereId());
    await insertPulledMarks(reply.marks ?? [], source, hereName());
    stored += result.stored;
    after = reply.through;
    if (reply.gone) {
      // A hole never closes: it only grows if retention passes more before it is read.
      gone = gone
        ? { from: Math.min(gone.from, reply.gone.from), to: Math.max(gone.to, reply.gone.to) }
        : reply.gone;
      holeAt = holeTimes({ ...link, ...holeAt }, reply);
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
      ...holeAt,
      peer_name: reply.source?.name || link.peer_name,
      last_error: null,
    });
    if (reply.through >= reply.settled) {
      break;
    }
  }
  return { stored };
}

/**
 * A link where we are the source and we call out (#137): ask the puller where it stands, read
 * our feed from there, deliver the range, until it is caught up or a pass's pages are spent.
 */
export async function serveLink(link: LinkRecord, deps: PullDeps = defaultDeps): Promise<{ delivered: number }> {
  const base = link.peer_url.replace(/\/+$/, "");
  const headers = { authorization: `Bearer ${link.secret ?? ""}`, "content-type": "application/json" };
  let delivered = 0;
  for (let page = 0; page < pullPagesPerPass; page++) {
    let ask: { after: number; limit: number };
    try {
      const res = await deps.fetch(`${base}/link/v1/ask`, { method: "POST", headers, signal: AbortSignal.timeout(15_000) });
      if (res.status === 401) {
        noteFailure(link.id, "refused: the link was removed at the puller");
        return { delivered };
      }
      if (!res.ok) {
        noteFailure(link.id, `the puller answered ${res.status}`);
        return { delivered };
      }
      ask = (await res.json()) as { after: number; limit: number };
    } catch (err) {
      noteFailure(link.id, failureWords(err));
      return { delivered };
    }
    const reply = await readFeed({
      id: link.id,
      q: link.q,
      after: ask.after,
      limit: ask.limit,
      retentionDays: getRetentionDays(),
      hereId: deps.hereId(),
    });
    try {
      const res = await deps.fetch(`${base}/link/v1/rows`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...reply, source: { id: deps.hereId(), name: instanceNameOrEmpty() } }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok && res.status !== 409) {
        noteFailure(link.id, `the puller answered ${res.status}`);
        return { delivered };
      }
    } catch (err) {
      noteFailure(link.id, failureWords(err));
      return { delivered };
    }
    delivered += reply.rows.length;
    noteContact(link.id, {
      at: deps.now(),
      position: reply.through,
      settled: reply.settled,
      ...(reply.arrived ? { arrived_at: reply.arrived } : {}),
      behind_rows: link.q.trim() === "" ? Math.max(0, reply.settled - reply.through) : null,
      last_error: null,
    });
    if (reply.refused || reply.through >= reply.settled) {
      break;
    }
  }
  return { delivered };
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
      if (link.connects !== "we" || isPaused(link)) {
        continue;
      }
      if (link.role === "pull") {
        await pullLink(link, deps);
      } else {
        await serveLink(link, deps);
      }
    }
  } finally {
    running = false;
  }
}

/** Start pulling at once for a link just made, without waiting for the next pass. */
export function pullSoon(id: string): void {
  const link = getLink(id);
  if (link && link.connects === "we") {
    const run = link.role === "pull" ? pullLink(link) : serveLink(link);
    void run.catch((err) => console.error("link pass failed", err));
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
