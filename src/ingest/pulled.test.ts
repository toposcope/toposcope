import { beforeAll, describe, expect, test } from "bun:test";
import { clickhouseQuery, pingClickHouse } from "../shared/clickhouse";
import { migrateStore } from "../shared/migrate";
import type { FeedRow } from "../feed/feed";
import { insertPulled } from "./pulled";

describe("pulled rows (#136)", () => {
  beforeAll(async () => {
    process.env.CLICKHOUSE_USER ??= "default";
    process.env.CLICKHOUSE_PASSWORD ??= "toposcope";
    if (!(await pingClickHouse())) throw new Error("ClickHouse is required for pulled rows");
    await migrateStore();
  });

  const tag = Date.now().toString(36);
  const service = `pulled${tag}`;
  const row = (seq: number, origin = `src-${tag}`, toposcope = "prod-eu"): FeedRow => ({
    seq,
    ts: new Date(Date.now() - 60_000).toISOString(),
    service,
    host: "api-1",
    level: "error",
    message: `row ${origin} ${seq}`,
    attrs: { e1: "aaaaaaaaaaaaaaaa", status: "500" },
    toposcope,
    origin: { id: origin, seq },
  });

  test("stored as it came, once: a retry, an overlap and a row of our own are not stored again", async () => {
    const first = await insertPulled([row(1), row(2), row(3)], { name: "prod-eu" }, "here-id");
    expect(first).toEqual({ stored: 3, skipped: 0 });
    // A retry of the same range, plus one new row, plus a row that left here and came back.
    const again = await insertPulled([row(2), row(3), row(4), row(9, "here-id")], { name: "prod-eu" }, "here-id");
    expect(again).toEqual({ stored: 1, skipped: 3 });
    const rows = await clickhouseQuery<{ message: string; e1: string; toposcope: string; src_seq: string | number; seq: string | number }>(
      `SELECT message, attr_map['e1'] AS e1, toposcope, src_seq, seq FROM logs WHERE service = {service:String} ORDER BY src_seq`,
      { service },
    );
    expect(rows.map((r) => Number(r.src_seq))).toEqual([1, 2, 3, 4]);
    // The source's e1, as it was; a position here for each.
    expect(rows.every((r) => r.e1 === "aaaaaaaaaaaaaaaa" && r.toposcope === "prod-eu" && Number(r.seq) > 0)).toBe(true);
  });

  test("a row that entered the source unnamed takes the source's name", async () => {
    const result = await insertPulled([row(1, `src2-${tag}`, "")], { name: "billing" }, "here-id");
    expect(result.stored).toBe(1);
    const rows = await clickhouseQuery<{ toposcope: string }>(
      `SELECT toposcope FROM logs WHERE service = {service:String} AND src_id = {id:String}`,
      { service, id: `src2-${tag}` },
    );
    expect(rows).toEqual([{ toposcope: "billing" }]);
  });
});
