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

describe("pulled marks (#138)", () => {
  test("stored under the instance they were posted at; a mark of ours that came back is not", async () => {
    const { insertPulledMarks } = await import("./pulled");
    const tag = Date.now().toString(36);
    const mark = (id: string, toposcope: string, end_ts: string | null = null) => ({
      id, ts: new Date(Date.now() - 60_000).toISOString(), end_ts, kind: "deploy" as const, service: "api", title: id, attrs: {}, toposcope, seq: 1,
    });
    const stored = await insertPulledMarks(
      [mark(`deploy-api-${tag}`, "prod-eu"), mark(`deploy-api-${tag}`, "edge-fra"), mark(`mine-${tag}`, "here"), mark(`hop-${tag}@prod-eu`, "prod-eu")],
      { name: "edge-fra" },
      "here",
    );
    expect(stored).toBe(3);
    const rows = await clickhouseQuery<{ id: string; toposcope: string }>(
      "SELECT id, toposcope FROM change_marks WHERE id LIKE {like:String} ORDER BY id",
      { like: `%${tag}%` },
    );
    expect(rows).toEqual([
      { id: `deploy-api-${tag}@edge-fra`, toposcope: "edge-fra" },
      { id: `deploy-api-${tag}@prod-eu`, toposcope: "prod-eu" },
      // A mark that already came through another hop keeps its one suffix.
      { id: `hop-${tag}@prod-eu`, toposcope: "prod-eu" },
    ]);
  });
});
