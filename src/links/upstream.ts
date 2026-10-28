import { heldSources, huntAst, rulesOut, type HeldLink, type HeldSource, type HeldState } from "../shared/held";
import { activeLinks, type LinkRecord } from "./store";

/**
 * A short source two hops away (#334). Each feed reply's header says where the source's own
 * sources stand (`upstream`), as its Search would tell them: an instance that pulls from the
 * edge tells the centre the edge is behind, and the centre's tells name the edge. What came to
 * the source from further away goes on the same way, so a chain of any length adds up; the
 * puller is left out of what it is told, and so is a source the link's filter rules out by
 * `toposcope`.
 */

/** No more sources than this travel on one header. */
const most = 200;

/** Sources as a puller is told them, for a link with this filter to this peer. */
export function upstreamFor(link: Pick<LinkRecord, "q" | "peer_name">, now = Date.now(), links: HeldLink[] = heldLinks()): HeldSource[] {
  const ast = huntAst(link.q);
  return heldSources(links, now)
    .filter((s) => s.name !== link.peer_name && !rulesOut(ast, "toposcope", s.name))
    .slice(0, most)
    .map(({ via: _via, ...s }) => s);
}

/** Every link, with what its source last said of its own sources: what `heldSources` reads. */
export function heldLinks(links: LinkRecord[] = activeLinks()): Array<LinkRecord & HeldLink> {
  return links.map((l) => ({ ...l, upstream: parseUpstream(l.upstream) })) as Array<LinkRecord & HeldLink>;
}

const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function parseState(raw: unknown): HeldState | null {
  const s = raw as Record<string, unknown> | null;
  if (s?.kind === "caught-up") return { kind: "caught-up" };
  if (s?.kind === "behind" && isTime(s.readTo)) return { kind: "behind", readTo: s.readTo };
  if (s?.kind === "quiet" && isTime(s.since) && isTime(s.knownTo) && (s.connects === "we" || s.connects === "they")) {
    return { kind: "quiet", since: s.since, knownTo: s.knownTo, connects: s.connects };
  }
  return null;
}

/** What another instance said, kept only where it reads as sources: JSON text or the header's field. */
export function parseUpstream(raw: unknown): HeldSource[] {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) {
    return [];
  }
  const out: HeldSource[] = [];
  for (const item of value.slice(0, most)) {
    const s = item as Record<string, unknown> | null;
    const state = parseState(s?.state);
    const hole = s?.hole as Record<string, unknown> | null | undefined;
    if (typeof s?.name !== "string" || !s.name || !state || !Array.isArray(s.filters)) continue;
    out.push({
      name: s.name,
      filters: s.filters.filter((f): f is string => typeof f === "string"),
      state,
      hole: hole && isTime(hole.from) && isTime(hole.to) ? { from: hole.from, to: hole.to } : null,
    });
  }
  return out;
}

/** How far behind a state is, in time: from where its rows are known to, to now; 0 when caught up. */
export function behindMs(state: HeldState, now: number): number {
  return state.kind === "behind" ? Math.max(0, now - state.readTo) : state.kind === "quiet" ? Math.max(0, now - state.knownTo) : 0;
}
