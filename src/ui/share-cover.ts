/** Shares in the UI (#228, frames 23g–23j): how a share reads in Settings → Shares. */

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

export function shareIsLive(share: ShareView, now = Date.now()): boolean {
  return share.revoked_at === null && share.expires_at > now;
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
