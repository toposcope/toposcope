import { describe, expect, test } from "bun:test";
import { formatBytesPair } from "./bytes";
import {
  byteRate,
  clickhouseStatsFromMetrics,
  cpuPercent,
  formatProcessBar,
  isHighPressure,
  ratesFromSamples,
} from "./system";

describe("cpuPercent", () => {
  test("is CPU-seconds over wall time, divided by quota cores", () => {
    expect(cpuPercent(1_000_000, 2000, 2)).toBe(25);
    expect(cpuPercent(2_000_000, 2000, 1)).toBe(100);
    expect(cpuPercent(1_000_000, 0, 1)).toBeNull();
  });
});

describe("byteRate", () => {
  test("bytes over elapsed ms", () => {
    expect(byteRate(2_000_000, 2000)).toBe(1_000_000);
    expect(byteRate(-1, 2000)).toBeNull();
  });
});

describe("clickhouseStatsFromMetrics", () => {
  const rows = new Map<string, number>([
    ["CGroupMemoryUsed", 6_969_954_304],
    ["CGroupMemoryTotal", 8_589_934_592],
    ["CGroupMaxCPU", 2],
    ["DiskUsed_default", 350_638_546_944],
    ["DiskTotal_default", 1_081_100_128_256],
    ["MemoryTracking", 990_991_399],
    ["OSCPUVirtualTimeMicroseconds", 3_262_645_786],
    ["ReadBufferFromFileDescriptorReadBytes", 362_969_317_810],
    ["WriteBufferFromFileDescriptorWriteBytes", 36_762_913_820],
  ]);

  test("uses cgroup mem vs the compose cap and default disk", () => {
    const { stats, sample } = clickhouseStatsFromMetrics(rows, undefined, 1000);
    expect(stats.mem_used).toBe(6_969_954_304);
    expect(stats.mem_limit).toBe(8_589_934_592);
    expect(stats.disk_used).toBe(350_638_546_944);
    expect(stats.disk_total).toBe(1_081_100_128_256);
    expect(stats.cpu).toBeNull();
    expect(stats.io_read).toBeNull();
    const diskUsed = stats.disk_used;
    const diskTotal = stats.disk_total;
    if (diskUsed == null || diskTotal == null) {
      throw new Error("expected default disk stats");
    }
    expect(formatProcessBar(stats, true)).toBe(
      `${formatBytesPair(stats.mem_used, stats.mem_limit)} ${formatBytesPair(diskUsed, diskTotal)}`,
    );
    expect(sample.cpuUs).toBe(3_262_645_786);
  });

  test("second sample fills CPU and disk IO rates", () => {
    const first = clickhouseStatsFromMetrics(rows, undefined, 1000);
    const next = new Map(rows);
    next.set("OSCPUVirtualTimeMicroseconds", 3_262_645_786 + 1_000_000);
    next.set("ReadBufferFromFileDescriptorReadBytes", 362_969_317_810 + 2_000_000);
    next.set("WriteBufferFromFileDescriptorWriteBytes", 36_762_913_820 + 4_000_000);
    const { stats } = clickhouseStatsFromMetrics(next, first.sample, 3000);
    expect(stats.cpu).toBe(25);
    expect(stats.io_read).toBe(1_000_000);
    expect(stats.io_write).toBe(2_000_000);
  });

  test("without a cgroup cap uses MemoryTracking and no limit", () => {
    const { stats } = clickhouseStatsFromMetrics(
      new Map([["MemoryTracking", 990_991_399]]),
      undefined,
      1,
    );
    expect(stats.mem_used).toBe(990_991_399);
    expect(stats.mem_limit).toBeNull();
    expect(formatProcessBar(stats, false)).toBe(formatBytesPair(990_991_399, null));
  });
});

describe("isHighPressure", () => {
  test("true at 90% of the cap", () => {
    expect(isHighPressure(9, 10)).toBe(true);
    expect(isHighPressure(8, 10)).toBe(false);
    expect(isHighPressure(9, null)).toBe(false);
  });
});

describe("ratesFromSamples", () => {
  test("ignores a counter reset", () => {
    const prev = { at: 1000, cpuUs: 5000, readBytes: 100, writeBytes: 100 };
    const next = { at: 3000, cpuUs: 10, readBytes: 1, writeBytes: 1 };
    expect(ratesFromSamples(prev, next, 1)).toEqual({
      cpu: null,
      io_read: null,
      io_write: null,
    });
  });
});
