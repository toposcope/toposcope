export const bootPhases = ["starting", "schema", "repair", "ready"] as const;
export type BootPhase = (typeof bootPhases)[number];

export type Health = {
  ok: boolean;
  phase: BootPhase;
  clickhouse: boolean;
  sqlite: boolean;
};

export function healthFromPings(
  phase: BootPhase,
  pings: { clickhouse: boolean; sqlite: boolean },
): { body: Health; status: 200 | 503 } {
  const ok = phase === "ready" && pings.clickhouse && pings.sqlite;
  return {
    body: {
      ok,
      phase,
      clickhouse: pings.clickhouse,
      sqlite: pings.sqlite,
    },
    status: ok ? 200 : 503,
  };
}

export function bootAllowsRequest(phase: BootPhase, path: string): boolean {
  if (path === "/api/health" || path === "/api/metrics") {
    return true;
  }
  return phase === "ready";
}
