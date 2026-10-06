import { describe, expect, test } from "bun:test";
import { parseChangeMark } from "../shared/change-mark";
import {
  clickhouseCommand,
  clickhouseInsertJsonEachRow,
  clickhouseQuery,
  pingClickHouse,
  toClickHouseDateTime,
} from "../shared/clickhouse";
import { fingerprintCutScanCap } from "../shared/fingerprint-cut";
import { logsCreateTableSql } from "../shared/migrate";
import { fingerprintCutScans, searchFingerprintCut } from "./fingerprint-cut";

const targetHex = "ffffffffffffffff";
const hour = 60 * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

function cutInput(service: string) {
  const openedAt = Date.now();
  const markTs = openedAt - hour;
  return {
    mark: parseChangeMark({
      id: service,
      kind: "deploy",
      service,
      title: "cardinality test",
      ts: iso(markTs),
    }),
    from: iso(openedAt - 2 * hour),
    to: iso(openedAt),
    opened: iso(openedAt),
    q: `service:${service}`,
    now: openedAt,
  };
}

function sideCounts(crowded: boolean, targetCount: number) {
  const rows = crowded
    ? Array.from({ length: fingerprintCutScanCap }, (_, i) => ({
        hex: (i + 1).toString(16).padStart(16, "0"),
        n: 2,
      }))
    : [];
  return [...rows, { hex: targetHex, n: targetCount }];
}

describe("fingerprint cut cardinality refusal", () => {
  test("refuses incomplete side counts before reading samples or classifying sets", async () => {
    const input = cutInput("cut_cardinality_mock");
    const counts = fingerprintCutScans.counts;
    const samples = fingerprintCutScans.samples;
    let sampleCalls = 0;
    fingerprintCutScans.counts = async () => sideCounts(true, 1);
    fingerprintCutScans.samples = async () => {
      sampleCalls++;
      return new Map();
    };
    try {
      const result = await searchFingerprintCut(input);
      expect(result.scan?.source).toBe("refused");
      expect(result.empty).toContain(String(fingerprintCutScanCap));
      expect(result.scan?.reason).toBe(result.empty);
      expect(result.sets).toEqual([]);
      expect(sampleCalls).toBe(0);
    } finally {
      fingerprintCutScans.counts = counts;
      fingerprintCutScans.samples = samples;
    }
  });
});

process.env.CLICKHOUSE_USER ??= "default";
process.env.CLICKHOUSE_PASSWORD ??= "toposcope";
process.env.CLICKHOUSE_URL ??= "http://127.0.0.1:8123";
const clickhouseAvailable = await pingClickHouse();

describe.skipIf(!clickhouseAvailable)("fingerprint cut cardinality ClickHouse", () => {
  async function crowdedCut(beforeCrowded: boolean, afterCrowded: boolean) {
    await clickhouseCommand(logsCreateTableSql);
    const service = `cutcard${crypto.randomUUID().replaceAll("-", "")}`;
    const input = cutInput(service);
    const markMs = Date.parse(input.mark.ts);
    const before = sideCounts(beforeCrowded, beforeCrowded ? 1 : 10);
    const after = sideCounts(afterCrowded, afterCrowded ? 1 : 10);
    const logs: string[] = [];
    for (const [ms, counts] of [
      [markMs - 60_000, before],
      [markMs + 60_000, after],
    ] as const) {
      for (const { hex, n } of counts) {
        for (let i = 0; i < n; i++) {
          logs.push(JSON.stringify({
            tenant_id: "default",
            ts: toClickHouseDateTime(iso(ms)),
            service,
            host: "cut-cardinality-test",
            level: "error",
            message: "cardinality test",
            attrs: JSON.stringify({ e1: hex }),
            attr_map: { e1: hex },
            trace_id: "",
          }));
        }
      }
    }
    await clickhouseInsertJsonEachRow(logs.join("\n"));
    const stored = await clickhouseQuery<{ before: string | number; after: string | number }>(`
      SELECT
        uniqExactIf(attr_map['e1'], ts < parseDateTime64BestEffort({mark:String})) AS before,
        uniqExactIf(attr_map['e1'], ts >= parseDateTime64BestEffort({mark:String})) AS after
      FROM logs
      WHERE service = {service:String}
    `, { service, mark: input.mark.ts });
    expect(Number(stored[0]?.before)).toBe(before.length);
    expect(Number(stored[0]?.after)).toBe(after.length);
    return searchFingerprintCut(input);
  }

  test("refuses a rank-201 before fingerprint instead of calling it First seen", async () => {
    const result = await crowdedCut(true, false);
    expect(result.scan?.source).toBe("refused");
    expect(result.sets).toEqual([]);
    expect(result.empty).toContain(String(fingerprintCutScanCap));
  });

  test("refuses a rank-201 after fingerprint instead of calling it Stopped", async () => {
    const result = await crowdedCut(false, true);
    expect(result.scan?.source).toBe("refused");
    expect(result.sets).toEqual([]);
    expect(result.empty).toContain(String(fingerprintCutScanCap));
  });

  test("refuses omission on both sides instead of returning apparently complete sets", async () => {
    const result = await crowdedCut(true, true);
    expect(result.scan?.source).toBe("refused");
    expect(result.sets).toEqual([]);
    expect(result.empty).toContain(String(fingerprintCutScanCap));
  });
});
