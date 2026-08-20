import { formatBytesPair } from "./bytes";

export type ProcessStats = {
  mem_used: number;
  mem_limit: number | null;
  disk_used: number | null;
  disk_total: number | null;
  cpu: number | null;
  io_read: number | null;
  io_write: number | null;
};

export type SystemSnapshot = {
  app: ProcessStats;
  clickhouse: ProcessStats | null;
};

export type CounterSample = {
  at: number;
  cpuUs: number;
  readBytes: number;
  writeBytes: number;
};

const HIGH_PRESSURE = 0.9;

export function finiteNonNeg(n: number | undefined): number | null {
  if (n == null || !Number.isFinite(n) || n < 0) {
    return null;
  }
  return n;
}

export function finitePositive(n: number | undefined): number | null {
  if (n == null || !Number.isFinite(n) || n <= 0) {
    return null;
  }
  return n;
}

export function isHighPressure(used: number, limit: number | null): boolean {
  if (limit == null || limit <= 0 || !Number.isFinite(used) || used < 0) {
    return false;
  }
  return used / limit >= HIGH_PRESSURE;
}

export function cpuPercent(
  cpuDeltaUs: number,
  elapsedMs: number,
  quotaCores: number | null,
): number | null {
  if (elapsedMs <= 0 || cpuDeltaUs < 0) {
    return null;
  }
  const elapsedUs = elapsedMs * 1000;
  const cores = quotaCores != null && quotaCores > 0 ? quotaCores : 1;
  const pct = (cpuDeltaUs / elapsedUs / cores) * 100;
  if (!Number.isFinite(pct) || pct < 0 || pct > 200) {
    return null;
  }
  return pct;
}

export function byteRate(delta: number, elapsedMs: number): number | null {
  if (elapsedMs <= 0 || delta < 0) {
    return null;
  }
  return (delta / elapsedMs) * 1000;
}

export function ratesFromSamples(
  prev: CounterSample | undefined,
  next: CounterSample,
  quotaCores: number | null,
): { cpu: number | null; io_read: number | null; io_write: number | null } {
  if (prev === undefined || next.at <= prev.at) {
    return { cpu: null, io_read: null, io_write: null };
  }
  const elapsedMs = next.at - prev.at;
  return {
    cpu: cpuPercent(next.cpuUs - prev.cpuUs, elapsedMs, quotaCores),
    io_read: byteRate(next.readBytes - prev.readBytes, elapsedMs),
    io_write: byteRate(next.writeBytes - prev.writeBytes, elapsedMs),
  };
}

export function clickhouseStatsFromMetrics(
  metrics: Map<string, number>,
  prev: CounterSample | undefined,
  now: number,
): { stats: ProcessStats; sample: CounterSample } {
  const memLimit = finitePositive(metrics.get("CGroupMemoryTotal"));
  const cgroupUsed = finiteNonNeg(metrics.get("CGroupMemoryUsed"));
  const tracking = finiteNonNeg(metrics.get("MemoryTracking"));
  const resident = finiteNonNeg(metrics.get("MemoryResident"));
  const memUsed =
    memLimit != null
      ? (cgroupUsed ?? tracking ?? resident ?? 0)
      : (tracking ?? resident ?? cgroupUsed ?? 0);
  const sample: CounterSample = {
    at: now,
    cpuUs: finiteNonNeg(metrics.get("OSCPUVirtualTimeMicroseconds")) ?? 0,
    readBytes:
      finiteNonNeg(metrics.get("ReadBufferFromFileDescriptorReadBytes")) ?? 0,
    writeBytes:
      finiteNonNeg(metrics.get("WriteBufferFromFileDescriptorWriteBytes")) ?? 0,
  };
  const rates = ratesFromSamples(
    prev,
    sample,
    finitePositive(metrics.get("CGroupMaxCPU")),
  );
  return {
    stats: {
      mem_used: memUsed,
      mem_limit: memLimit,
      disk_used: finiteNonNeg(metrics.get("DiskUsed_default")),
      disk_total: finitePositive(metrics.get("DiskTotal_default")),
      cpu: rates.cpu,
      io_read: rates.io_read,
      io_write: rates.io_write,
    },
    sample,
  };
}

export function formatProcessBar(stats: ProcessStats, showDisk: boolean): string {
  const mem = formatBytesPair(stats.mem_used, stats.mem_limit);
  if (!showDisk || stats.disk_used == null) {
    return mem;
  }
  return `${mem} ${formatBytesPair(stats.disk_used, stats.disk_total)}`;
}
