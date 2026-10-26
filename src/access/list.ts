import type { Context } from "hono";
import { envIngestTokenName, ingestToken } from "../auth";
import { allTokens } from "../control/tokens";
import { kidLabel } from "../links/key";
import { activeLinks, openLinkKeys } from "../links/store";
import { listShares } from "../share/store";
import { clickhouseQuery, toIsoTimestamp } from "../shared/clickhouse";
import { accessKey, pendingAccessUse, type AccessKind } from "./use";

/**
 * Access (#265, frame 26i): every way in or out of this instance other than the operator password,
 * as one list. Kinds are said in words; open or refused rows come first.
 */
export type AccessRowKind = "token" | "invite" | "link" | "share";
export type AccessRow = {
  kind: AccessRowKind;
  /** Its kind in plain words (29a): which way rows move, from this instance's side. */
  verb: "token" | "we copy from" | "copies from us" | "key not used yet" | "share";
  /** Which way rows move: in to here, out from here (a key says the way it will move once pasted). */
  direction: "in" | "out";
  id: string;
  name: string;
  lets_through: string;
  scope: string;
  expires_at: number | null;
  last_used_at: number | null;
  today: { used: number; refused: number };
  /** How to end it: a DELETE route, or null when it is not revoked here (the `.env` token). */
  revoke: string | null;
  /** Where its own page is, when it has one. */
  open: string | null;
};
export type AccessRefusal = { ts: string; kind: string; name: string; reason: string };

type UseRow = { name: string; kind: string; used: string | number; refused: string | number; last: string | null };

async function useToday(): Promise<{ by: Map<string, { used: number; refused: number; last: number | null }>; refusals: AccessRefusal[] }> {
  const where = "tenant_id = 'default' AND service = 'toposcope' AND ts >= now64(3) - INTERVAL 1 DAY AND (attr_map['access'] != '' OR attr_map['share'] != '')";
  const name = "if(attr_map['access'] != '', attr_map['access'], attr_map['share'])";
  const kind = "if(attr_map['kind'] != '', attr_map['kind'], 'share')";
  const [rows, refused] = await Promise.all([
    clickhouseQuery<UseRow>(
      `SELECT ${name} AS name, ${kind} AS kind,
         sumIf(toUInt64OrZero(attr_map['n']) + toUInt64OrZero(attr_map['reads']) + toUInt64OrZero(attr_map['cached']), attr_map['status'] = 'used') AS used,
         countIf(attr_map['status'] = 'refused') AS refused,
         maxIf(ts, attr_map['status'] = 'used') AS last
       FROM logs WHERE ${where} GROUP BY name, kind`,
      {},
    ).catch(() => [] as UseRow[]),
    clickhouseQuery<{ ts: string; name: string; kind: string; reason: string }>(
      `SELECT ts, ${name} AS name, ${kind} AS kind, attr_map['reason'] AS reason
       FROM logs WHERE ${where} AND attr_map['status'] = 'refused' ORDER BY ts DESC LIMIT 20`,
      {},
    ).catch(() => []),
  ]);
  const by = new Map<string, { used: number; refused: number; last: number | null }>();
  for (const r of rows) {
    const used = Number(r.used);
    by.set(accessKey(r.kind as AccessKind, r.name), { used, refused: Number(r.refused), last: used > 0 && r.last ? Date.parse(toIsoTimestamp(String(r.last))) : null });
  }
  for (const [k, t] of pendingAccessUse()) {
    const prev = by.get(k) ?? { used: 0, refused: 0, last: null };
    by.set(k, { used: prev.used + t.used, refused: prev.refused + t.refused, last: t.last ?? prev.last });
  }
  return { by, refusals: refused.map((r) => ({ ts: toIsoTimestamp(String(r.ts)), kind: r.kind, name: r.name, reason: r.reason })) };
}

function shareScopeWords(scope: { metric_names: string[]; metric_labels: Record<string, string>; logs: string | null; split: string[] }): string {
  const parts: string[] = [];
  const labels = Object.entries(scope.metric_labels).map(([k, v]) => `${k}:${v}`).join(" ");
  if (scope.logs) {
    parts.push(scope.logs);
  } else if (labels) {
    parts.push(labels);
  }
  if (scope.metric_names.length) {
    parts.push(scope.metric_names.length === 1 ? `metric:${scope.metric_names[0]}` : `${scope.metric_names.length} metrics`);
  }
  parts.push(scope.split.length ? `split ${scope.split.join(", ")}` : "split none");
  return parts.join(" · ");
}

export async function accessRows(now = Date.now()): Promise<{ rows: AccessRow[]; refusals: AccessRefusal[] }> {
  const { by, refusals } = await useToday();
  const use = (kind: AccessKind, name: string) => by.get(accessKey(kind, name)) ?? { used: 0, refused: 0, last: null };
  const rows: AccessRow[] = [];
  if (ingestToken()) {
    const u = use("token", envIngestTokenName);
    rows.push({
      kind: "token", verb: "token", direction: "in", id: "env", name: envIngestTokenName,
      lets_through: "from .env · sends logs, metrics, traces, marks",
      scope: "any", expires_at: null, last_used_at: u.last, today: { used: u.used, refused: u.refused }, revoke: null, open: null,
    });
  }
  for (const t of allTokens()) {
    const u = use("token", t.name);
    rows.push({
      kind: "token", verb: "token", direction: "in", id: t.id, name: t.name,
      lets_through: "sends logs, metrics, traces, marks",
      scope: "any", expires_at: null, last_used_at: u.last ?? t.last_used_at ?? null, today: { used: u.used, refused: u.refused },
      revoke: `/api/api-tokens/${encodeURIComponent(t.id)}`, open: null,
    });
  }
  for (const k of openLinkKeys(now)) {
    rows.push({
      kind: "invite", verb: "key not used yet", direction: k.kind === "offer" ? "out" : "in", id: k.kid, name: kidLabel(k.kid),
      lets_through: k.kind === "offer" ? "becomes a link once pasted there · it will copy from us" : "becomes a link once pasted there · we will copy from it",
      scope: k.q || "every row", expires_at: k.until, last_used_at: null, today: { used: 0, refused: 0 },
      revoke: `/api/links/keys/${encodeURIComponent(k.kid)}`, open: null,
    });
  }
  for (const l of activeLinks()) {
    const peer = l.peer_name || l.peer_url;
    const u = use("link", l.peer_name || l.id);
    rows.push({
      kind: "link", verb: l.role === "pull" ? "we copy from" : "copies from us", direction: l.role === "pull" ? "in" : "out", id: l.id,
      name: peer,
      lets_through: l.role === "pull" ? "this instance pulls its rows" : "pulls our rows within the scope",
      scope: l.q || "every row", expires_at: null, last_used_at: l.last_contact_at, today: { used: u.used, refused: u.refused },
      revoke: `/api/links/${encodeURIComponent(l.id)}`, open: `?view=access&link=${encodeURIComponent(l.id)}`,
    });
  }
  for (const s of listShares()) {
    if (s.revoked_at !== null) {
      continue;
    }
    const u = use("share", s.name);
    const origins = s.embed.frame_ancestors.map((o) => o.replace(/^https?:\/\//, ""));
    rows.push({
      kind: "share", verb: "share", direction: "out", id: s.id, name: s.name,
      lets_through: origins.length ? `shown on ${origins.join(", ")}` : "JSON only",
      scope: shareScopeWords(s.scope), expires_at: s.expires_at, last_used_at: u.last, today: { used: u.used, refused: u.refused },
      revoke: `/api/shares/${encodeURIComponent(s.name)}`, open: `?view=access&share=${encodeURIComponent(s.name)}`,
    });
  }
  // Refused today first, then invites waiting to be pasted, then the rest by last use.
  rows.sort((a, b) => Number(b.today.refused > 0) - Number(a.today.refused > 0) || (b.last_used_at ?? 0) - (a.last_used_at ?? 0));
  return { rows, refusals };
}

/** `GET /api/access`. */
export async function accessRoute(c: Context): Promise<Response> {
  return c.json(await accessRows());
}
