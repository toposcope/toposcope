import type { Context } from "hono";
import { clickhouseQuery, toIsoTimestamp } from "../shared/clickhouse";

/**
 * When a fingerprint was first and last seen, how often and on how many hosts (#261, frame 26e):
 * the event panel's fingerprint line. Reads `logs` through the `mapValues(attr_map)` bloom index.
 */
export const fingerprintHexRe = /^[0-9a-f]{6,64}$/;
export const fingerprintSeenDefaultMs = 7 * 24 * 60 * 60_000;

export type FingerprintSeen = { hex: string; from: string; to: string; first_ts: string | null; last_ts: string | null; count: number; hosts: number };

export async function fingerprintSeen(hex: string, fromIso: string, toIso: string): Promise<FingerprintSeen> {
  const rows = await clickhouseQuery<{ first: string; last: string; n: string | number; hosts: string | number }>(
    `
    SELECT min(ts) AS first, max(ts) AS last, count() AS n, uniqExact(host) AS hosts
    FROM logs
    WHERE tenant_id = 'default'
      AND ts >= parseDateTime64BestEffort({from:String})
      AND ts < parseDateTime64BestEffort({to:String})
      AND attr_map['e1'] = {hex:String}
    SETTINGS max_execution_time = 10
    `,
    { from: fromIso, to: toIso, hex },
  );
  const row = rows[0];
  const n = Number(row?.n ?? 0);
  return {
    hex,
    from: fromIso,
    to: toIso,
    first_ts: n > 0 && row ? toIsoTimestamp(row.first) : null,
    last_ts: n > 0 && row ? toIsoTimestamp(row.last) : null,
    count: n,
    hosts: Number(row?.hosts ?? 0),
  };
}

/** `GET /api/fingerprints/:hex?from&to` — the last 7 days when no window is given. */
export async function fingerprintSeenRoute(c: Context): Promise<Response> {
  const hex = (c.req.param("hex") ?? "").toLowerCase();
  if (!fingerprintHexRe.test(hex)) {
    return c.json({ error: "a fingerprint is 6 to 64 hex characters" }, 400);
  }
  const toMs = c.req.query("to") ? Date.parse(c.req.query("to")!) : Date.now();
  const fromMs = c.req.query("from") ? Date.parse(c.req.query("from")!) : toMs - fingerprintSeenDefaultMs;
  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || fromMs >= toMs) {
    return c.json({ error: "from and to are times, from before to" }, 400);
  }
  return c.json(await fingerprintSeen(hex, new Date(fromMs).toISOString(), new Date(toMs).toISOString()));
}
