import { describe, expect, test } from "bun:test";
import { compileQuery } from "./compile";
import {
  autoHistogramIntervalId,
  canUseAttrValuesMv,
  canUseHistogramMv,
  clampHistogramInterval,
  histogramIntervalAllowed,
  histogramIntervalSeconds,
  histogramIntervalSql,
  histogramUsesMinuteRollup,
  isOneColumnInterval,
  parseHistogramChart,
  parseHistogramInterval,
  parseHistogramSplit,
  rollupSource,
  tightenHistogramFrom,
} from "./histogram";
import { capHistogramSeries, foldHistogramRows } from "./index";

describe("canUseHistogramMv", () => {
  test("empty and service/level/host-only queries use the MV", () => {
    expect(canUseHistogramMv(compileQuery(""))).toBe(true);
    expect(canUseHistogramMv(compileQuery("level:error service:api"))).toBe(true);
    expect(canUseHistogramMv(compileQuery("host:api-1"))).toBe(true);
  });

  test("message terms and multi-attr filters fall back to raw logs", () => {
    expect(canUseHistogramMv(compileQuery("timeout"))).toBe(false);
    expect(canUseHistogramMv(compileQuery("path:/v1 user_id:1"))).toBe(false);
  });

  test("core OR and NOT stay on the minute rollup", () => {
    expect(canUseHistogramMv(compileQuery("level:error OR level:fatal"))).toBe(
      true,
    );
    expect(canUseHistogramMv(compileQuery("not level:error"))).toBe(true);
  });
});

describe("canUseAttrValuesMv", () => {
  test("a single attr equality uses the values rollup", () => {
    expect(canUseAttrValuesMv(compileQuery("user_id:u-5"))).toBe(true);
    expect(canUseAttrValuesMv(compileQuery("path:/v1 host:api-1"))).toBe(true);
    expect(canUseAttrValuesMv(compileQuery("user_id:1 path:/v1"))).toBe(false);
    expect(canUseAttrValuesMv(compileQuery("user_id:1 timeout"))).toBe(false);
  });

  test("a single attr prefix glob uses the values rollup", () => {
    expect(canUseAttrValuesMv(compileQuery("status:5*"))).toBe(true);
    expect(canUseAttrValuesMv(compileQuery("status:5* service:api"))).toBe(true);
    expect(canUseAttrValuesMv(compileQuery("level:error OR status:500"))).toBe(
      false,
    );
  });

  test("a numeric comparison scans logs, never a rollup", () => {
    const q = compileQuery("duration_ms:>100");
    expect(rollupSource(q)).toBe("logs");
    expect(canUseHistogramMv(q)).toBe(false);
    expect(canUseAttrValuesMv(q)).toBe(false);
    expect(rollupSource(compileQuery("duration_ms:>100 service:api"))).toBe("logs");
  });

  test("UUID-like and lookup-role equality scan logs, never the values MV", () => {
    const hex = compileQuery("request_id:0123456789abcdef0123456789abcdef");
    expect(rollupSource(hex)).toBe("logs");
    expect(canUseAttrValuesMv(hex)).toBe(false);
    expect(canUseAttrValuesMv(compileQuery("user_id:u-5"))).toBe(true);
    expect(canUseAttrValuesMv(compileQuery("user_id:u-5"), ["user_id"])).toBe(
      false,
    );
    expect(rollupSource(compileQuery("user_id:u-5"), ["user_id"])).toBe("logs");
  });
});

describe("histogramIntervalSeconds", () => {
  const hour = 60 * 60 * 1000;

  test("picks a human bar count from the window", () => {
    expect(histogramIntervalSeconds()).toBe(60);
    expect(
      histogramIntervalSeconds(
        "2026-08-14T00:00:00.000Z",
        "2026-08-14T01:00:00.000Z",
      ),
    ).toBe(60);
    expect(
      histogramIntervalSeconds(
        "2026-08-14T00:00:00.000Z",
        "2026-08-14T04:00:00.000Z",
      ),
    ).toBe(300);
    expect(
      histogramIntervalSeconds(
        "2026-08-13T00:00:00.000Z",
        "2026-08-14T00:00:00.000Z",
      ),
    ).toBe(900);
    expect(
      histogramIntervalSeconds(
        "2026-08-07T00:00:00.000Z",
        "2026-08-14T00:00:00.000Z",
      ),
    ).toBe(3600);
    expect(autoHistogramIntervalId(1_000)).toBe("10ms");
    expect(autoHistogramIntervalId(15 * 60 * 1000)).toBe("10s");
    expect(autoHistogramIntervalId(hour)).toBe("1m");
    expect(autoHistogramIntervalId(4 * hour)).toBe("5m");
    expect(autoHistogramIntervalId(24 * hour)).toBe("15m");
    expect(autoHistogramIntervalId(7 * 24 * hour)).toBe("1h");
    expect(autoHistogramIntervalId(30 * 24 * hour)).toBe("4h");
    expect(autoHistogramIntervalId(90 * 24 * hour)).toBe("1d");
    expect(autoHistogramIntervalId(365 * 24 * hour)).toBe("7d");
  });

  test("honors a clamped step override", () => {
    expect(
      histogramIntervalSeconds(
        "2026-08-13T00:00:00.000Z",
        "2026-08-14T00:00:00.000Z",
        "5m",
      ),
    ).toBe(300);
    expect(
      histogramIntervalSeconds(
        "2026-08-13T00:00:00.000Z",
        "2026-08-14T00:00:00.000Z",
        "1m",
      ),
    ).toBe(900);
    expect(histogramIntervalSql(300_000)).toBe("INTERVAL 5 minute");
    expect(histogramIntervalSql(3_600_000)).toBe("INTERVAL 1 hour");
    expect(histogramIntervalSql(604_800_000)).toBe("INTERVAL 7 day");
    expect(histogramIntervalSql(1)).toBe("INTERVAL 1 MILLISECOND");
    expect(histogramIntervalSql(10)).toBe("INTERVAL 10 MILLISECOND");
    expect(histogramIntervalSql(1_000)).toBe("INTERVAL 1 SECOND");
    expect(histogramUsesMinuteRollup(10_000)).toBe(false);
    expect(histogramUsesMinuteRollup(60_000)).toBe(true);
  });

  test("parse and allow-list", () => {
    expect(parseHistogramInterval("15m")).toBe("15m");
    expect(parseHistogramInterval("1ms")).toBe("1ms");
    expect(parseHistogramInterval("nope")).toBeUndefined();
    expect(histogramIntervalAllowed(24 * hour, "1m")).toBe(false);
    expect(histogramIntervalAllowed(24 * hour, "5m")).toBe(true);
    expect(histogramIntervalAllowed(15 * 60 * 1000, "1h")).toBe(false);
    expect(histogramIntervalAllowed(1, "1ms")).toBe(true);
    expect(isOneColumnInterval(1_000, "1s")).toBe(true);
    expect(isOneColumnInterval(1, "1ms")).toBe(true);
    expect(clampHistogramInterval(24 * hour, "1m")).toBeNull();
    expect(clampHistogramInterval(24 * hour, "15m")).toBe("15m");
  });
});

describe("foldHistogramRows", () => {
  test("groups level rows into one bucket per minute", () => {
    const buckets = foldHistogramRows([
      { bucket: "2026-08-14 10:00:00", level: "info", n: 5 },
      { bucket: "2026-08-14 10:00:00", level: "error", n: "2" },
      { bucket: "2026-08-14 10:01:00", level: "warn", n: 1 },
    ]);
    expect(buckets).toEqual([
      {
        t: "2026-08-14T10:00:00.000Z",
        n: 7,
        series: { info: 5, error: 2 },
        by_level: { info: 5, error: 2 },
      },
      {
        t: "2026-08-14T10:01:00.000Z",
        n: 1,
        series: { warn: 1 },
        by_level: { warn: 1 },
      },
    ]);
  });

  test("counts unknown levels in the total only", () => {
    const buckets = foldHistogramRows([
      { bucket: "2026-08-14 10:00:00", level: "notice", n: 3 },
    ]);
    expect(buckets[0]?.n).toBe(3);
    expect(buckets[0]?.series).toEqual({ notice: 3 });
    expect(buckets[0]?.by_level).toEqual({});
  });
});

describe("parseHistogramSplit", () => {
  test("defaults to level", () => {
    expect(parseHistogramSplit(undefined)).toBe("level");
    expect(parseHistogramSplit("nope")).toBe("level");
    expect(parseHistogramSplit("host")).toBe("host");
  });
});

describe("parseHistogramChart", () => {
  test("defaults to stacked", () => {
    expect(parseHistogramChart(undefined)).toBe("stacked");
    expect(parseHistogramChart("nope")).toBe("stacked");
    expect(parseHistogramChart("line")).toBe("line");
    expect(parseHistogramChart("area")).toBe("area");
  });
});

describe("tightenHistogramFrom", () => {
  test("floors since to the bucket and does not go before from", () => {
    expect(
      tightenHistogramFrom(
        "2026-08-14T14:00:00.000Z",
        "2026-08-14T14:59:37.000Z",
        60_000,
      ),
    ).toBe("2026-08-14T14:59:00.000Z");
    expect(
      tightenHistogramFrom(
        "2026-08-14T15:00:00.000Z",
        "2026-08-14T14:59:37.000Z",
        60_000,
      ),
    ).toBe("2026-08-14T15:00:00.000Z");
  });

  test("leaves from alone when since is missing", () => {
    expect(
      tightenHistogramFrom("2026-08-14T14:00:00.000Z", undefined, 60_000),
    ).toBe("2026-08-14T14:00:00.000Z");
  });
});

describe("capHistogramSeries", () => {
  test("keeps level and none splits intact", () => {
    const buckets = foldHistogramRows([
      { bucket: "2026-08-14 10:00:00", k: "error", n: 2 },
    ]);
    expect(capHistogramSeries(buckets, "level")).toEqual(buckets);
  });

  test("rolls extra service keys into other", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      bucket: "2026-08-14 10:00:00",
      k: `svc-${i}`,
      n: 10 - i,
    }));
    const capped = capHistogramSeries(foldHistogramRows(rows), "service");
    const keys = Object.keys(capped[0]?.series ?? {});
    expect(keys).toContain("other");
    expect(keys).toHaveLength(9);
    expect(capped[0]?.series.other).toBe(1 + 2);
  });
});
