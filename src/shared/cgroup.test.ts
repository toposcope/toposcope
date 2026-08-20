import { describe, expect, test } from "bun:test";
import {
  parseCgroupCpuMax,
  parseCgroupMemoryCurrent,
  parseCgroupMemoryMax,
  parseCgroupV1Cpu,
  readCgroupLimits,
} from "./cgroup";

describe("parseCgroupMemoryMax", () => {
  test("reads a docker 512M / 8G cap", () => {
    expect(parseCgroupMemoryMax("536870912")).toBe(536870912);
    expect(parseCgroupMemoryMax("8589934592")).toBe(8589934592);
  });

  test("treats max and v1 unlimited as no cap", () => {
    expect(parseCgroupMemoryMax("max")).toBeNull();
    expect(parseCgroupMemoryMax("9223372036854771712")).toBeNull();
    expect(parseCgroupMemoryMax("0")).toBeNull();
  });
});

describe("parseCgroupMemoryCurrent", () => {
  test("allows zero", () => {
    expect(parseCgroupMemoryCurrent("0")).toBe(0);
    expect(parseCgroupMemoryCurrent("4096")).toBe(4096);
  });
});

describe("parseCgroupCpuMax", () => {
  test("quota over period", () => {
    expect(parseCgroupCpuMax("max 100000")).toBeNull();
    expect(parseCgroupCpuMax("100000 100000")).toBe(1);
    expect(parseCgroupCpuMax("200000 100000")).toBe(2);
    expect(parseCgroupCpuMax("25000 100000")).toBe(0.25);
  });
});

describe("parseCgroupV1Cpu", () => {
  test("quota -1 is unlimited", () => {
    expect(parseCgroupV1Cpu("-1", "100000")).toBeNull();
    expect(parseCgroupV1Cpu("100000", "100000")).toBe(1);
  });
});

describe("readCgroupLimits", () => {
  test("prefers cgroup v2 files", () => {
    const files: Record<string, string> = {
      "/sys/fs/cgroup/memory.max": "536870912",
      "/sys/fs/cgroup/memory.current": "50331648",
      "/sys/fs/cgroup/cpu.max": "100000 100000",
    };
    expect(readCgroupLimits((path) => files[path] ?? null)).toEqual({
      memUsed: 50331648,
      memLimit: 536870912,
      cpuQuota: 1,
    });
  });

  test("falls back to v1", () => {
    const files: Record<string, string> = {
      "/sys/fs/cgroup/memory/memory.limit_in_bytes": "8589934592",
      "/sys/fs/cgroup/memory/memory.usage_in_bytes": "1048576",
      "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "200000",
      "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000",
    };
    expect(readCgroupLimits((path) => files[path] ?? null)).toEqual({
      memUsed: 1048576,
      memLimit: 8589934592,
      cpuQuota: 2,
    });
  });

  test("missing files are empty limits", () => {
    expect(readCgroupLimits(() => null)).toEqual({
      memUsed: null,
      memLimit: null,
      cpuQuota: null,
    });
  });
});
