import { readFileSync } from "node:fs";

const V2_MEM_MAX = "/sys/fs/cgroup/memory.max";
const V2_MEM_CUR = "/sys/fs/cgroup/memory.current";
const V2_CPU_MAX = "/sys/fs/cgroup/cpu.max";
const V1_MEM_LIMIT = "/sys/fs/cgroup/memory/memory.limit_in_bytes";
const V1_MEM_USAGE = "/sys/fs/cgroup/memory/memory.usage_in_bytes";
const V1_CPU_QUOTA = "/sys/fs/cgroup/cpu/cpu.cfs_quota_us";
const V1_CPU_PERIOD = "/sys/fs/cgroup/cpu/cpu.cfs_period_us";

/** cgroup v1 "unlimited" is ~2^63-1, often page-aligned. */
const UNLIMITED = 1n << 62n;

export type CgroupLimits = {
  memUsed: number | null;
  memLimit: number | null;
  cpuQuota: number | null;
};

export type ReadText = (path: string) => string | null;

function defaultReadText(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

export function parseCgroupMemoryMax(raw: string): number | null {
  const text = raw.trim();
  if (text === "" || text === "max") {
    return null;
  }
  try {
    const n = BigInt(text);
    if (n <= 0n || n >= UNLIMITED) {
      return null;
    }
    return Number(n);
  } catch {
    return null;
  }
}

export function parseCgroupMemoryCurrent(raw: string): number | null {
  const text = raw.trim();
  if (text === "" || text === "max") {
    return null;
  }
  try {
    const n = BigInt(text);
    if (n < 0n || n >= UNLIMITED) {
      return null;
    }
    return Number(n);
  } catch {
    return null;
  }
}

/** `cpu.max`: "max 100000" or "200000 100000" (quota period). */
export function parseCgroupCpuMax(raw: string): number | null {
  const parts = raw.trim().split(/\s+/);
  const quota = parts[0];
  if (quota === undefined || quota === "max") {
    return null;
  }
  const period = parts[1] ?? "100000";
  const q = Number(quota);
  const p = Number(period);
  if (!Number.isFinite(q) || !Number.isFinite(p) || q < 0 || p <= 0) {
    return null;
  }
  return q / p;
}

export function parseCgroupV1Cpu(quotaRaw: string, periodRaw: string): number | null {
  const q = Number(quotaRaw.trim());
  const p = Number(periodRaw.trim());
  if (!Number.isFinite(q) || !Number.isFinite(p) || q < 0 || p <= 0) {
    return null;
  }
  return q / p;
}

export function readCgroupLimits(readText: ReadText = defaultReadText): CgroupLimits {
  const v2Max = readText(V2_MEM_MAX);
  const v2Cur = readText(V2_MEM_CUR);
  const v2Cpu = readText(V2_CPU_MAX);
  if (v2Max !== null || v2Cur !== null || v2Cpu !== null) {
    return {
      memUsed: v2Cur !== null ? parseCgroupMemoryCurrent(v2Cur) : null,
      memLimit: v2Max !== null ? parseCgroupMemoryMax(v2Max) : null,
      cpuQuota: v2Cpu !== null ? parseCgroupCpuMax(v2Cpu) : null,
    };
  }
  const v1Limit = readText(V1_MEM_LIMIT);
  const v1Usage = readText(V1_MEM_USAGE);
  const v1Quota = readText(V1_CPU_QUOTA);
  const v1Period = readText(V1_CPU_PERIOD);
  return {
    memUsed: v1Usage !== null ? parseCgroupMemoryCurrent(v1Usage) : null,
    memLimit: v1Limit !== null ? parseCgroupMemoryMax(v1Limit) : null,
    cpuQuota:
      v1Quota !== null && v1Period !== null
        ? parseCgroupV1Cpu(v1Quota, v1Period)
        : null,
  };
}
