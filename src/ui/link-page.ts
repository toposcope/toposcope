/** Pure pieces of a link's page (#267, frame 26m). */

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
};

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
