import type { Context } from "hono";
import { receivedCount } from "../ingest/received-ring";
import { clickhouseQuery, toIsoTimestamp } from "../shared/clickhouse";
import {
  fillMinuteCounts,
  ratePerSecond,
  type MinuteCount,
} from "../shared/throughput";

const LIVE_SECONDS = 5;
const SPARKLINE_MINUTES = 60;
const MINUTE_MS = 60_000;

type MinuteRow = {
  t: string;
  n: string | number;
};

function num(value: string | number): number {
  return typeof value === "number" ? value : Number(value) || 0;
}

export async function ingestSparkline(now = Date.now()): Promise<MinuteCount[]> {
  const toMs = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  const fromMs = toMs - (SPARKLINE_MINUTES - 1) * MINUTE_MS;
  const rows = await clickhouseQuery<MinuteRow>(
    `
      SELECT minute AS t, countMerge(n) AS n
      FROM logs_by_minute
      WHERE tenant_id = {tenant_id:String}
        AND minute >= parseDateTime64BestEffort({from:String})
      GROUP BY minute
      ORDER BY minute
    `,
    {
      tenant_id: "default",
      from: new Date(fromMs).toISOString(),
    },
  );
  return fillMinuteCounts(
    fromMs,
    toMs,
    rows.map((row) => ({
      t: toIsoTimestamp(String(row.t)),
      n: num(row.n),
    })),
  );
}

export async function getThroughput(now = Date.now()): Promise<{
  per_second: number;
  histogram: MinuteCount[];
}> {
  const histogram = await ingestSparkline(now);
  const live = ratePerSecond(receivedCount(LIVE_SECONDS, now), LIVE_SECONDS);
  const last = histogram[histogram.length - 1];
  const written = ratePerSecond(last?.n ?? 0, 60);
  return {
    per_second: live > 0 ? live : written,
    histogram,
  };
}

export async function throughputRoute(c: Context): Promise<Response> {
  return c.json(await getThroughput());
}
