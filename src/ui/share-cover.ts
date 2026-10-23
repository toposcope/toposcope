/**
 * Shares in the UI (#228, frames 23g–23k): which share covers a metric panel, the script tag
 * Copy embed puts on the clipboard, and how a share reads in one line.
 */

export type ShareView = {
  name: string;
  scope: {
    metric_names: string[];
    /** `service:agental`, as `ml=` writes it. */
    metric_labels: string;
    logs: string | null;
    split: string[];
    narrow: string[];
  };
  limits: { min_step: string; max_range: string; max_lookback: string; reads_per_minute: number };
  embed: { frame_ancestors: string[]; ticket_ttl: string };
  expires_at: number;
  revoked_at: number | null;
  created_at: number;
  use?: { last_read_at: string | null; reads_24h: number; refused_24h: number };
};

export type EmbedPanel = {
  /** `fleet_cpu_seconds`, or `p99:http.server.duration`. */
  metric: string;
  labels: Record<string, string>;
  split: string | null;
};

function labelsOf(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of text.split(",")) {
    const colon = part.indexOf(":");
    if (colon > 0) out[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
  }
  return out;
}

function nameAllowed(patterns: string[], name: string): boolean {
  return patterns.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p));
}

/** Why a live share cannot draw this panel, or null when it can. */
export function shareMisses(share: ShareView, panel: EmbedPanel): string | null {
  const name = panel.metric.replace(/^(count|sum|avg|p50|p90|p99):/, "");
  if (!nameAllowed(share.scope.metric_names, name)) {
    return `${name} is not in it`;
  }
  const fixed = labelsOf(share.scope.metric_labels);
  for (const [key, value] of Object.entries(fixed)) {
    if (panel.labels[key] !== undefined && panel.labels[key] !== value) {
      return `it is fixed to ${key}:${value}`;
    }
  }
  for (const [key, value] of Object.entries(panel.labels)) {
    if (fixed[key] !== value && !share.scope.narrow.includes(key)) {
      return `it cannot narrow by ${key}`;
    }
  }
  // A panel with no matcher for a scope label still reads inside the scope: the share adds it.
  if (panel.split && !share.scope.split.includes(panel.split)) {
    return `it cannot split by ${panel.split}`;
  }
  return null;
}

export function shareIsLive(share: ShareView, now = Date.now()): boolean {
  return share.revoked_at === null && share.expires_at > now;
}

/**
 * The share Copy embed uses (23k): the first live one, by name, that covers the panel; else why
 * none does. Null when there are no live shares at all, and the row is not shown.
 */
export function shareCovering(
  shares: readonly ShareView[],
  panel: EmbedPanel,
  now = Date.now(),
): { share: ShareView } | { why: string } | null {
  const live = shares.filter((s) => shareIsLive(s, now)).sort((a, b) => a.name.localeCompare(b.name));
  if (live.length === 0) {
    return null;
  }
  for (const share of live) {
    if (shareMisses(share, panel) === null) {
      return { share };
    }
  }
  const metric = panel.metric.replace(/^(count|sum|avg|p50|p90|p99):/, "");
  const fixed = Object.entries(panel.labels).map(([k, v]) => `${k}:${v}`).join(",");
  return { why: `no share covers ${metric}${fixed ? ` on ${fixed}` : ""}` };
}

/** The script tag Copy embed copies: everything but the ticket, which the host's backend mints. */
export function embedTag(origin: string, panel: EmbedPanel, opts: { range: string; title?: string }): string {
  const attrs: Array<[string, string]> = [["ticket", "TICKET"], ["metric", panel.metric]];
  const ml = Object.entries(panel.labels).map(([k, v]) => `${k}:${v}`).join(",");
  if (ml) attrs.push(["ml", ml]);
  if (panel.split) attrs.push(["split", panel.split]);
  attrs.push(["range", opts.range]);
  if (opts.title) attrs.push(["title", opts.title]);
  const quote = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<script src="${origin}/embed.js"\n  ${attrs.map(([k, v]) => `data-${k}="${quote(v)}"`).join(" ")}></script>`;
}

/** The scope in one line, as 23g reads it: `service:agental · fleet_* · logs service:agental`. */
export function scopeLine(share: ShareView): string {
  const parts = [share.scope.metric_labels, share.scope.metric_names.join(" "), share.scope.logs ? `logs ${share.scope.logs}` : "no logs"];
  return parts.filter(Boolean).join(" · ");
}

/** The limits in one line: `≥1m · ≤30d · back 400d · 300/min · expires 2027-10-23`. */
export function limitsLine(share: ShareView): string {
  const l = share.limits;
  return `≥${l.min_step} · ≤${l.max_range} · back ${l.max_lookback} · ${l.reads_per_minute}/min · expires ${new Date(share.expires_at).toISOString().slice(0, 10)}`;
}

/** Under two weeks left: said in amber instead of the date (23g). */
export function expiresSoon(share: ShareView, now = Date.now()): string | null {
  const days = Math.ceil((share.expires_at - now) / 86_400_000);
  return share.revoked_at === null && days <= 14 ? `expires in ${Math.max(0, days)}d` : null;
}
