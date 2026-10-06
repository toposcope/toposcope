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
import { requireCompiled } from "./compile";
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
  async function insertCutFixture(
    before: ReturnType<typeof sideCounts>,
    after: ReturnType<typeof sideCounts>,
  ) {
    await clickhouseCommand(logsCreateTableSql);
    const service = `cutcard${crypto.randomUUID().replaceAll("-", "")}`;
    const input = cutInput(service);
    const markMs = Date.parse(input.mark.ts);
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
    return input;
  }

  async function crowdedCut(beforeCrowded: boolean, afterCrowded: boolean) {
    const input = await insertCutFixture(
      sideCounts(beforeCrowded, beforeCrowded ? 1 : 10),
      sideCounts(afterCrowded, afterCrowded ? 1 : 10),
    );
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

  test("accepts exactly 200 fingerprints on each side with complete counts", async () => {
    const input = await insertCutFixture(
      sideCounts(true, 1).slice(1),
      sideCounts(true, 3).slice(1),
    );
    const result = await searchFingerprintCut(input);
    expect(result.scan).toBeUndefined();
    expect(result.empty).toBe("");
    expect(result.sets.find((set) => set.id === "first_seen")?.count).toBe(0);
    expect(result.sets.find((set) => set.id === "stopped")?.count).toBe(0);
    const stillHere = result.sets.find((set) => set.id === "still_here");
    expect(stillHere?.count).toBe(fingerprintCutScanCap);
    expect(stillHere?.rows.find((row) => row.hex === targetHex)).toMatchObject({
      before: 1,
      after: 3,
    });
  });

  test("bounds the physical count query at 201 fingerprints including the overflow row", async () => {
    const before = Array.from({ length: fingerprintCutScanCap + 50 }, (_, i) => ({
      hex: (i + 1).toString(16).padStart(16, "0"),
      n: 1,
    }));
    const input = await insertCutFixture(before, sideCounts(false, 1));
    const rows = await fingerprintCutScans.counts(
      input.from,
      input.mark.ts,
      requireCompiled(input.q),
    );
    expect(rows).toHaveLength(fingerprintCutScanCap + 1);
  });
});
