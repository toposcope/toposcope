import { beforeAll, describe, expect, test } from "bun:test";
import { clickhouseInsertJsonEachRow, pingClickHouse, toClickHouseDateTime } from "../shared/clickhouse";
import { migrateStore } from "../shared/migrate";
import { maxChangeMarks } from "../shared/change-mark";
import { changeMarksBetween, searchChangeMarks } from "./marks";

const second = 1000;
const hour = 60 * 60 * second;
const day = 24 * hour;
const iso = (ms: number) => new Date(ms).toISOString();

async function insertDeploys(service: string, stamps: number[]): Promise<void> {
  await clickhouseInsertJsonEachRow(
    stamps
      .map((ts, i) =>
        JSON.stringify({
          tenant_id: "default",
          ts: toClickHouseDateTime(iso(ts)),
          kind: "deploy",
          service,
          title: `v1.${i}`,
          attrs: {},
          id: `deploy-${service}-${i}`,
          end_ts: null,
        }),
      )
      .join("\n"),
    "change_marks",
  );
}

describe("GET /api/marks past 500 marks in a window ClickHouse", () => {
  beforeAll(async () => {
    process.env.CLICKHOUSE_USER ??= "default";
    process.env.CLICKHOUSE_PASSWORD ??= "toposcope";
    if (!(await pingClickHouse())) throw new Error("ClickHouse is required for the marks listing");
    await migrateStore();
  });

  // Both stretches sit 15 to 27 days back, inside the 30-day TTL and clear of the 2 to 14 days
  // the fingerprint cut's tests need quiet, and each is minutes wide.
  test("a window with more than 500 marks lists them all, the newest included", async () => {
    // agental's 43 deploys a day put about 1,300 on Watch's 30d lane; 500 kept only the oldest.
    const service = `busy${Date.now()}`;
    const start = Math.floor(Date.now() / second) * second - 21 * day - Math.floor(Math.random() * 6 * 24) * hour;
    const stamps = Array.from({ length: 30 * 43 }, (_, i) => start + i * 5 * second);
    await insertDeploys(service, stamps);
    const { marks } = await searchChangeMarks({ range: "30d", service });
    expect(marks.length).toBe(stamps.length);
    expect(marks[0]!.id).toBe(`deploy-${service}-0`);
    expect(marks.at(-1)!.id).toBe(`deploy-${service}-${stamps.length - 1}`);
    for (let i = 1; i < marks.length; i++) {
      expect(Date.parse(marks[i]!.ts)).toBeGreaterThan(Date.parse(marks[i - 1]!.ts));
    }
  });

  test("past the cap the newest marks survive, still oldest first", async () => {
    const service = `capped${Date.now()}`;
    const start = Math.floor(Date.now() / second) * second - 15 * day - Math.floor(Math.random() * 5 * 24) * hour;
    const over = 25;
    // One every 10ms, so the whole stretch is under two minutes.
    const stamps = Array.from({ length: maxChangeMarks + over }, (_, i) => start + i * 10);
    await insertDeploys(service, stamps);
    const from = iso(start);
    const to = iso(stamps.at(-1)! + 1);
    const { marks } = await searchChangeMarks({ from, to, service });
    expect(marks.length).toBe(maxChangeMarks);
    expect(marks[0]!.id).toBe(`deploy-${service}-${over}`);
    expect(marks.at(-1)!.id).toBe(`deploy-${service}-${stamps.length - 1}`);

    const between = (await changeMarksBetween(from, to)).filter((m) => m.service === service);
    expect(between.length).toBe(maxChangeMarks);
    expect(between[0]!.id).toBe(`deploy-${service}-${over}`);
    expect(between.at(-1)!.id).toBe(`deploy-${service}-${stamps.length - 1}`);
  });
});
