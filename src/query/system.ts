import { statSync } from "node:fs";
import type { Context } from "hono";
import { readCgroupLimits } from "../shared/cgroup";
import { clickhouseQuery } from "../shared/clickhouse";
import { defaultSqlitePath } from "../shared/sqlite-path";
import {
  clickhouseStatsFromMetrics,
  ratesFromSamples,
  type CounterSample,
  type ProcessStats,
  type SystemSnapshot,
} from "../shared/system";

type MetricRow = {
  metric: string;
  value: string | number;
};

const METRICS_SQL = `
SELECT metric, toFloat64(value) AS value
FROM system.metrics
WHERE metric = 'MemoryTracking'
UNION ALL
SELECT metric, value
FROM system.asynchronous_metrics
WHERE metric IN (
  'CGroupMemoryUsed',
  'CGroupMemoryTotal',
  'CGroupMaxCPU',
  'DiskUsed_default',
  'DiskTotal_default',
  'MemoryResident'
)
UNION ALL
SELECT event AS metric, toFloat64(value) AS value
FROM system.events
WHERE event IN (
  'OSCPUVirtualTimeMicroseconds',
  'ReadBufferFromFileDescriptorReadBytes',
  'WriteBufferFromFileDescriptorWriteBytes'
)
`;

const samples: { app?: CounterSample; clickhouse?: CounterSample } = {};

function num(value: string | number): number {
  return typeof value === "number" ? value : Number(value) || 0;
}

function sqliteBytes(): number | null {
  const path = defaultSqlitePath();
  if (path === ":memory:") {
    return null;
  }
  try {
    const n = statSync(path).size;
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}

function collectApp(now: number): ProcessStats {
  const rss = process.memoryUsage().rss;
  const usage = process.cpuUsage();
  const cgroup = readCgroupLimits();
  const sample: CounterSample = {
    at: now,
    cpuUs: usage.user + usage.system,
    readBytes: 0,
    writeBytes: 0,
  };
  const prev = samples.app;
  samples.app = sample;
  const memLimit = cgroup.memLimit;
  const rates = ratesFromSamples(prev, sample, cgroup.cpuQuota);
  return {
    mem_used: memLimit != null ? (cgroup.memUsed ?? rss) : rss,
    mem_limit: memLimit,
    disk_used: sqliteBytes(),
    disk_total: null,
    cpu: rates.cpu,
    io_read: null,
    io_write: null,
  };
}

async function collectClickHouse(now: number): Promise<ProcessStats | null> {
  const rows = await clickhouseQuery<MetricRow>(METRICS_SQL);
  const metrics = new Map<string, number>();
  for (const row of rows) {
    metrics.set(row.metric, num(row.value));
  }
  const { stats, sample } = clickhouseStatsFromMetrics(
    metrics,
    samples.clickhouse,
    now,
  );
  samples.clickhouse = sample;
  return stats;
}

export async function getSystemStats(now = Date.now()): Promise<SystemSnapshot> {
  const app = collectApp(now);
  let clickhouse: ProcessStats | null = null;
  try {
    clickhouse = await collectClickHouse(now);
  } catch {
    clickhouse = null;
  }
  return { app, clickhouse };
}

export async function systemRoute(c: Context): Promise<Response> {
  return c.json(await getSystemStats());
}
