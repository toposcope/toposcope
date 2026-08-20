export function ratePerSecond(count: number, windowSeconds: number): number {
  if (windowSeconds <= 0 || count <= 0) {
    return 0;
  }
  return count / windowSeconds;
}

export function formatRate(n: number): string {
  if (!Number.isFinite(n) || n < 0.005) {
    return "0";
  }
  if (n < 1) {
    return n.toFixed(2);
  }
  if (n < 10) {
    return n.toFixed(1);
  }
  if (n < 1000) {
    return String(Math.round(n));
  }
  if (n < 1_000_000) {
    const k = n / 1000;
    return k < 10 ? `${k.toFixed(1)}k` : `${Math.round(k)}k`;
  }
  const m = n / 1_000_000;
  return m < 10 ? `${m.toFixed(1)}M` : `${Math.round(m)}M`;
}

const MINUTE_MS = 60_000;

export type MinuteCount = { t: string; n: number };

export function fillMinuteCounts(
  fromMs: number,
  toMs: number,
  rows: MinuteCount[],
): MinuteCount[] {
  const start = Math.floor(fromMs / MINUTE_MS) * MINUTE_MS;
  const end = Math.floor(toMs / MINUTE_MS) * MINUTE_MS;
  if (!start || !end || end < start) {
    return rows;
  }
  const byMinute = new Map<number, number>();
  for (const row of rows) {
    const ms = Date.parse(row.t);
    if (Number.isNaN(ms)) {
      continue;
    }
    byMinute.set(Math.floor(ms / MINUTE_MS) * MINUTE_MS, row.n);
  }
  const filled: MinuteCount[] = [];
  for (let t = start; t <= end; t += MINUTE_MS) {
    filled.push({
      t: new Date(t).toISOString(),
      n: byMinute.get(t) ?? 0,
    });
  }
  return filled;
}
