import type { LinkKind } from "./link-kinds";
import { caughtUpWithinMs, type HeldSource } from "../shared/held";
import { heldLag, positionLines } from "../shared/held-words";

/** Pure pieces of a link's page (#267, frame 26m). */

/** A line per kind (#329, frame 33b): each on the link's one position. */
export type KindLine = {
  kind: LinkKind;
  ticked: boolean;
  state: "caught up" | "behind" | "a hole" | "not sent" | "unticked at the source" | "paused";
  not_sent?: string;
  gone?: { from: number; to: number };
  rows_day: number;
  bytes_day: number;
};

export type LinkPageData = {
  id: string;
  role: "pull" | "serve";
  peer: string;
  peer_url: string;
  q: string;
  paused: boolean;
  scope_here: boolean;
  position: number;
  settled: number;
  behind_rows: number | null;
  arrived_at: string | null;
  last_contact_at: number | null;
  last_error: string | null;
  created_at: number;
  holes: Array<{ from: string; to: string }>;
  pulled: Array<{ t: string; n: number }>;
  pulled_24h: number;
  kinds: KindLine[];
  /** Pull: how far behind the peer is here, in time (#334). */
  behind_ms?: number | null;
  /** Sources further away whose rows come through this link, and where each stands (#334). */
  further?: Array<HeldSource & { behind_ms: number }>;
};

/** "4m behind" under the Behind card, once the peer is behind by more than a poll's worth. */
export function behindLagWords(l: Pick<LinkPageData, "behind_ms" | "paused">): string | null {
  return !l.paused && l.behind_ms != null && l.behind_ms >= caughtUpWithinMs ? `${heldLag(l.behind_ms)} behind` : null;
}

/** A source further away, in the words Search's held group uses: "4m behind · read to 14:56:02". */
export function furtherWords(source: HeldSource, now: number): { text: string; ok: boolean } {
  const line = positionLines(source, now)[0];
  return line ? { text: line, ok: false } : { text: "caught up", ok: true };
}

/** The link's name in the crumb is the other instance (29b). */
export function linkTitle(l: Pick<LinkPageData, "role" | "peer">): string {
  return l.peer;
}

/** The kind chip (29b): which way rows move, in the words Access uses. */
export function linkKind(l: Pick<LinkPageData, "role">): { glyph: string; words: string } {
  return l.role === "pull" ? { glyph: "←", words: "we copy from" } : { glyph: "→", words: "copies from us" };
}

/** "Behind 4 rows", "caught up", "behind, how far unknown": where it stands. */
export function behindWords(l: Pick<LinkPageData, "behind_rows" | "position" | "settled" | "paused">): { text: string; ok: boolean } {
  if (l.paused) {
    return { text: "paused", ok: false };
  }
  if (l.behind_rows !== null) {
    return l.behind_rows === 0 ? { text: "caught up", ok: true } : { text: `${l.behind_rows.toLocaleString("en-US")} rows`, ok: l.behind_rows < 1000 };
  }
  return l.position >= l.settled ? { text: "caught up", ok: true } : { text: "reading", ok: true };
}

/** Rows per hour over the day the page draws. */
export function ratePerHour(pulled24h: number): string {
  const h = pulled24h / 24;
  return h >= 1000 ? `${(h / 1000).toFixed(1)}K/h` : `${Math.round(h)}/h`;
}

/** The 96 quarter-hours of the last day, with the hole (if any) marked as a floor. */
export function quarterBars(pulled: Array<{ t: string; n: number }>, holes: Array<{ from: string; to: string }>, nowMs: number): Array<{ t: number; n: number; gap: boolean }> {
  const q = 15 * 60_000;
  const end = Math.floor(nowMs / q) * q;
  const by = new Map(pulled.map((p) => [Date.parse(p.t), p.n]));
  const out: Array<{ t: number; n: number; gap: boolean }> = [];
  for (let t = end - 95 * q; t <= end; t += q) {
    const gap = holes.some((h) => Date.parse(h.from) < t + q && Date.parse(h.to) > t);
    out.push({ t, n: by.get(t) ?? 0, gap });
  }
  return out;
}

/** What a kind is, in the By kind table, when nothing is wrong (33b). */
const kindIs: Record<LinkKind, string> = {
  logs: "rows, message text included",
  marks: "every mark the scope does not rule out by service",
  traces: "spans, attributes as sent",
  metrics: "points and buckets",
  profiles: "samples, with their spans",
  monitors: "results, read-only on the puller",
};

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * A kind's line in words (33b): the state with its dot, and the note beside it. A server reason
 * like "the filter names level" is shown as "not sent: the filter names level".
 */
export function kindLineWords(
  line: KindLine,
  l: Pick<LinkPageData, "role" | "peer">,
): { state: string; tone: "ok" | "warn" | "off"; note: string } {
  const source = l.role === "pull" ? l.peer : "this instance";
  switch (line.state) {
    case "unticked at the source":
      return { state: "unticked at the source", tone: "off", note: `${source} sends none on this link` };
    case "not sent":
      return { state: "not sent", tone: "off", note: `not sent: ${line.not_sent ?? "the scope cannot decide it"}` };
    case "a hole":
      return {
        state: "a hole",
        tone: "warn",
        note: line.gone ? `${ymd(line.gone.from)} → ${ymd(line.gone.to)} gone at the source` : "some rows were gone at the source",
      };
    case "paused":
      return { state: "paused", tone: "warn", note: kindIs[line.kind] };
    case "behind":
      return { state: "behind", tone: "warn", note: kindIs[line.kind] };
    default:
      return { state: "caught up", tone: "ok", note: kindIs[line.kind] };
  }
}

/** The kinds a link carries, and those unticked at the source, for "Which way, and what". */
export function kindsCarried(lines: readonly KindLine[]): { carries: LinkKind[]; unticked: LinkKind[] } {
  return { carries: lines.filter((k) => k.ticked).map((k) => k.kind), unticked: lines.filter((k) => !k.ticked).map((k) => k.kind) };
}
