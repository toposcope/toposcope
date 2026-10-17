import { compileQuery, type QueryNode } from "../query/compile";

/**
 * What this instance holds (#139): for each source it pulls from, how far its rows are here, told
 * in time. A source whose rows inside a window are not all here is short for that window, and
 * every count it could feed there is a floor.
 */

/** A pull link as `GET /api/links` lists it: the fields Search reads. */
export type HeldLink = {
  role: "pull" | "serve";
  connects: "we" | "they";
  peer_name: string;
  q: string;
  position: number;
  settled: number;
  arrived_at: string | null;
  last_contact_at: number | null;
  last_error: string | null;
  created_at: number;
  gone_from: number | null;
  gone_to: number | null;
  gone_from_at: string | null;
  gone_to_at: string | null;
};

/** Behind by less than this reads as caught up, so polls do not toggle chrome. */
export const caughtUpWithinMs = 30_000;
/** A link not read this long is quiet: a pass runs every 5 seconds. */
export const quietAfterMs = 30_000;

export type HeldState =
  | { kind: "caught-up" }
  /** Read to `readTo`: the source's rows that arrived after it are not here yet. */
  | { kind: "behind"; readTo: number }
  /**
   * No contact since `since`: "not answering" when we call, "has not called" when they do. Its rows
   * are here up to `knownTo`: the contact itself if it was caught up then, else what it had read.
   */
  | { kind: "quiet"; since: number; knownTo: number; connects: "we" | "they" };

export type HeldSource = {
  name: string;
  /** The filters its links pull through, word for word; empty when one of them takes everything. */
  filters: string[];
  state: HeldState;
  /** Rows the source dropped before they were read, closed at both ends; the far end is a day boundary. */
  hole: { from: number; to: number } | null;
};

export type HeldGap = {
  source: string;
  kind: "behind" | "quiet" | "hole";
  from: number;
  /** A behind or quiet gap is open to now. */
  to: number;
};

function linkState(link: HeldLink, now: number): HeldState {
  const since = link.last_contact_at ?? link.created_at;
  if (link.last_error !== null || now - since > quietAfterMs) {
    // Known up to the last contact if it was caught up then, else up to what it had read.
    const readTo = link.arrived_at ? Date.parse(link.arrived_at) : since;
    const knownTo = link.last_contact_at !== null && link.position >= link.settled ? link.last_contact_at : Math.min(readTo, since);
    return { kind: "quiet", since, knownTo, connects: link.connects };
  }
  if (link.position >= link.settled || !link.arrived_at) {
    return { kind: "caught-up" };
  }
  const readTo = Date.parse(link.arrived_at);
  return now - readTo < caughtUpWithinMs ? { kind: "caught-up" } : { kind: "behind", readTo };
}

const rank = { "caught-up": 0, behind: 1, quiet: 2 } as const;

/** Sources by name, from the links this instance pulls through; a source's worst link speaks for it. */
export function heldSources(links: HeldLink[], now: number): HeldSource[] {
  const byName = new Map<string, HeldSource & { everything: boolean }>();
  for (const link of links) {
    if (link.role !== "pull" || !link.peer_name) {
      continue;
    }
    const state = linkState(link, now);
    const hole =
      link.gone_from_at && link.gone_to_at
        ? { from: Date.parse(link.gone_from_at), to: Date.parse(link.gone_to_at) }
        : null;
    const q = link.q.trim();
    const prev = byName.get(link.peer_name);
    if (!prev) {
      byName.set(link.peer_name, { name: link.peer_name, filters: q ? [q] : [], everything: !q, state, hole });
      continue;
    }
    prev.everything ||= !q;
    if (q && !prev.filters.includes(q)) {
      prev.filters.push(q);
    }
    if (rank[state.kind] > rank[prev.state.kind]) {
      prev.state = state;
    } else if (state.kind === "behind" && prev.state.kind === "behind") {
      prev.state = { kind: "behind", readTo: Math.min(state.readTo, prev.state.readTo) };
    } else if (state.kind === "quiet" && prev.state.kind === "quiet") {
      prev.state = { ...prev.state, since: Math.min(state.since, prev.state.since), knownTo: Math.min(state.knownTo, prev.state.knownTo) };
    }
    if (hole) {
      prev.hole = prev.hole ? { from: Math.min(prev.hole.from, hole.from), to: Math.max(prev.hole.to, hole.to) } : hole;
    }
  }
  return [...byName.values()].map(({ everything, ...source }) => ({
    ...source,
    filters: everything ? [] : source.filters,
  }));
}

/** The spans of a source's rows that are not here: open to now while behind or quiet, and a hole. */
export function sourceGaps(source: HeldSource, now: number): HeldGap[] {
  const gaps: HeldGap[] = [];
  if (source.hole) {
    gaps.push({ source: source.name, kind: "hole", ...source.hole });
  }
  if (source.state.kind === "behind") {
    gaps.push({ source: source.name, kind: "behind", from: source.state.readTo, to: now });
  } else if (source.state.kind === "quiet") {
    gaps.push({ source: source.name, kind: "quiet", from: source.state.knownTo, to: now });
  }
  return gaps;
}

export type Window = { from: number; to: number };

/** Gaps that overlap the window: only these make a count over it a floor. */
export function gapsIn(sources: HeldSource[], window: Window, now: number): HeldGap[] {
  return sources.flatMap((s) => sourceGaps(s, now)).filter((g) => g.from < window.to && g.to > window.from);
}

export function shortIn(sources: HeldSource[], window: Window, now: number): HeldSource[] {
  const names = new Set(gapsIn(sources, window, now).map((g) => g.source));
  return sources.filter((s) => names.has(s.name));
}

type Tri = boolean | null;

/** Whether a row with `key` = `value` could match: false only on a plain mismatch the query proves. */
function evalKey(node: QueryNode | null, key: string, value: string): Tri {
  if (!node) {
    return true;
  }
  switch (node.op) {
    case "kv":
      if (node.key !== key) return null;
      return node.glob ? value.startsWith(node.value) : value === node.value;
    case "and": {
      const a = evalKey(node.a, key, value);
      const b = evalKey(node.b, key, value);
      if (a === false || b === false) return false;
      if (a === true && b === true) return true;
      return null;
    }
    case "or": {
      const a = evalKey(node.a, key, value);
      const b = evalKey(node.b, key, value);
      if (a === true || b === true) return true;
      if (a === false && b === false) return false;
      return null;
    }
    case "not": {
      const a = evalKey(node.a, key, value);
      return a === null ? null : !a;
    }
    default:
      return null;
  }
}

/** True when the query proves no row with `key` = `value` matches. */
export function rulesOut(ast: QueryNode | null, key: string, value: string): boolean {
  return evalKey(ast, key, value) === false;
}

function conjuncts(node: QueryNode | null): QueryNode[] {
  if (!node) return [];
  return node.op === "and" ? [...conjuncts(node.a), ...conjuncts(node.b)] : [node];
}

/** The exact `key:value` terms a query requires: only these are read for exceptions. */
function plainTerms(ast: QueryNode | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const node of conjuncts(ast)) {
    if (node.op === "kv" && !node.glob) {
      out.set(node.key, node.value);
    }
  }
  return out;
}

const astCache = new Map<string, QueryNode | null>();
function astOf(q: string): QueryNode | null {
  let ast = astCache.get(q);
  if (ast === undefined) {
    if (astCache.size > 500) {
      astCache.clear();
    }
    const compiled = compileQuery(q);
    ast = compiled.faults.length > 0 ? null : compiled.ast;
    astCache.set(q, ast);
  }
  return ast;
}

/** A filter rules a count out when its own `key:value` terms mismatch the hunt's or the value's. */
function filterRulesOut(filter: string, hunt: QueryNode | null, value?: { key: string; value: string }): boolean {
  const needs = plainTerms(astOf(filter));
  if (value) {
    const wanted = needs.get(value.key);
    if (wanted !== undefined && wanted !== value.value) {
      return true;
    }
  }
  for (const [key, v] of plainTerms(hunt)) {
    const wanted = needs.get(key);
    if (wanted !== undefined && wanted !== v) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a short source could feed a count: a hunt (and, for a facet value or a bar, that value)
 * over a window it is short in. It cannot when the hunt names other sources (`toposcope:prod-us`),
 * or when every filter it comes through rules the count out by a plain `key:value` mismatch.
 * Never because a value has not come from it so far.
 */
export function canFeed(source: HeldSource, hunt: QueryNode | null, value?: { key: string; value: string }): boolean {
  if (rulesOut(hunt, "toposcope", source.name)) {
    return false;
  }
  if (value?.key === "toposcope" && value.value !== source.name) {
    return false;
  }
  if (source.filters.length > 0 && source.filters.every((f) => filterRulesOut(f, hunt, value))) {
    return false;
  }
  return true;
}

/** The short sources that could feed this count; a count is a floor when there is any. */
export function feeders(short: HeldSource[], hunt: QueryNode | null, value?: { key: string; value: string }): HeldSource[] {
  return short.filter((s) => canFeed(s, hunt, value));
}

/** Whether every term of a source's filter is already a term of the hunt, so it cuts nothing the hunt kept. */
export function filterImplied(filter: string, hunt: QueryNode | null): boolean {
  const have = new Set(conjuncts(hunt).map((n) => JSON.stringify(n)));
  const need = conjuncts(astOf(filter));
  return need.length > 0 && need.every((n) => have.has(JSON.stringify(n)));
}

export function huntAst(q: string): QueryNode | null {
  return astOf(q);
}

/**
 * The hunt a facet counts its own field's values under: its own field's terms dropped (a term
 * under OR or NOT takes its whole branch with it), as the facets read the store (`omit`).
 */
export function omitKey(node: QueryNode | null, key: string): QueryNode | null {
  return omitWhere(node, (k) => k === key);
}

/** The query with every term on a key `drop` names left out, as `omitKey` does for one. */
export function omitWhere(node: QueryNode | null, drop: (key: string) => boolean): QueryNode | null {
  if (!node) {
    return null;
  }
  switch (node.op) {
    case "kv":
    case "cmp":
      return drop(node.key) ? null : node;
    case "and": {
      const a = omitWhere(node.a, drop);
      const b = omitWhere(node.b, drop);
      return a && b ? { op: "and", a, b } : (a ?? b);
    }
    case "or": {
      const a = omitWhere(node.a, drop);
      const b = omitWhere(node.b, drop);
      return a && b ? { op: "or", a, b } : null;
    }
    case "not": {
      const a = omitWhere(node.a, drop);
      return a ? { op: "not", a } : null;
    }
    default:
      return node;
  }
}
