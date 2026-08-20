import { describe, expect, test } from "bun:test";
import {
  formatByteRate,
  formatBytes,
  formatBytesPair,
  formatCpuPercent,
} from "./bytes";

describe("formatBytes", () => {
  test("picks 1024-based units", () => {
    expect(formatBytes(0)).toBe("0B");
    expect(formatBytes(512)).toBe("512B");
    expect(formatBytes(1024)).toBe("1K");
    expect(formatBytes(48 * 1024 ** 2)).toBe("48M");
    expect(formatBytes(8 * 1024 ** 3)).toBe("8G");
    expect(formatBytes(1.5 * 1024 ** 4)).toBe("1.5T");
  });
});

describe("formatBytesPair", () => {
  test("shares one unit like 48/512M and 6.97/8G", () => {
    expect(formatBytesPair(48 * 1024 ** 2, 512 * 1024 ** 2)).toBe("48/512M");
    expect(formatBytesPair(6.97 * 1024 ** 3, 8 * 1024 ** 3)).toBe("6.97/8G");
    expect(formatBytesPair(8589934592, 8589934592)).toBe("8/8G");
  });

  test("omits the limit when missing", () => {
    expect(formatBytesPair(48 * 1024 ** 2, null)).toBe("48M");
    expect(formatBytesPair(48 * 1024 ** 2, 0)).toBe("48M");
  });
});

describe("formatCpuPercent", () => {
  test("compact percents", () => {
    expect(formatCpuPercent(0)).toBe("0%");
    expect(formatCpuPercent(3.2)).toBe("3.2%");
    expect(formatCpuPercent(12.4)).toBe("12%");
  });
});

describe("formatByteRate", () => {
  test("adds /s", () => {
    expect(formatByteRate(1024)).toBe("1K/s");
    expect(formatByteRate(12.4 * 1024 ** 2)).toBe("12.4M/s");
  });
});
