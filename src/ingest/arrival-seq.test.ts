import { beforeAll, describe, expect, test } from "bun:test";
import { pingClickHouse, toClickHouseDateTime } from "../shared/clickhouse";
import { migrateStore } from "../shared/migrate";
import { search } from "../query/index";
import { insertEvents } from "./index";
import {
  allocateArrivalSeq,
  arrivalSeqSettled,
  loadArrivalSeq,
  releaseArrivalSeq,
  resetArrivalSeqForTests,
} from "./arrival-seq";

describe("arrival sequence (#133)", () => {
  beforeAll(async () => {
    process.env.CLICKHOUSE_USER ??= "default";
    process.env.CLICKHOUSE_PASSWORD ??= "toposcope";
    if (!(await pingClickHouse())) throw new Error("ClickHouse is required for the arrival sequence");
    await migrateStore();
  });

  test("600 rows in one millisecond page through Load more, none skipped and none repeated", async () => {
    const service = `seqpage${Date.now()}`;
    const ts = new Date(Date.now() - 60_000).toISOString();
    const events = Array.from({ length: 600 }, (_, i) => ({
      ts,
      service,
      level: "info" as const,
      message: `row ${i}`,
    }));
    await insertEvents(events.slice(0, 300));
    await insertEvents(events.slice(300));
    const from = new Date(Date.parse(ts) - 60_000).toISOString();
    const to = new Date(Date.parse(ts) + 60_000).toISOString();
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await search({ q: `service:${service}`, from, to, limit: 200, cursor });
      seen.push(...result.events.map((e) => e.message));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    expect(seen).toHaveLength(600);
    expect(new Set(seen).size).toBe(600);
  });

  test("a row that arrives late gets a higher number than every row stored before it", async () => {
    const service = `seqlate${Date.now()}`;
    const now = Date.now();
    await insertEvents([{ ts: new Date(now - 1_000).toISOString(), service, level: "info", message: "on time" }]);
    // An hour late: its event time is older than every row before it.
    await insertEvents([{ ts: new Date(now - 3_600_000).toISOString(), service, level: "info", message: "late" }]);
    const result = await search({
      q: `service:${service}`,
      from: new Date(now - 2 * 3_600_000).toISOString(),
      to: new Date(now).toISOString(),
      limit: 10,
    });
    const seqOf = (m: string) => result.events.find((e) => e.message === m)?.seq ?? 0;
    expect(seqOf("on time")).toBeGreaterThan(0);
    expect(seqOf("late")).toBeGreaterThan(seqOf("on time"));
    expect(toClickHouseDateTime(new Date(now).toISOString())).toBeTruthy();
  });

  test("after a restart the counter starts above every number it reserved", async () => {
    const before = await allocateArrivalSeq(1);
    releaseArrivalSeq(before);
    resetArrivalSeqForTests();
    const after = await allocateArrivalSeq(1);
    releaseArrivalSeq(after);
    // `before` was never stored, so the rows stored end below it: restarting from them would hand
    // its number out again. The counter starts past its reservation instead.
    expect(after.from).toBeGreaterThan(before.to + 1);
  });

  test("settled up to: an insert still running holds back every number from its first", async () => {
    const a = await allocateArrivalSeq(5);
    const b = await allocateArrivalSeq(5);
    expect(b.from).toBe(a.to + 1);
    releaseArrivalSeq(b);
    expect(arrivalSeqSettled()).toBe(a.from - 1);
    releaseArrivalSeq(a);
    expect(arrivalSeqSettled()).toBe(b.to);
  });
});

describe("settled after a restart (#136)", () => {
  test("loading the counter says how far it is before anything new arrives", async () => {
    const before = await allocateArrivalSeq(1);
    releaseArrivalSeq(before);
    resetArrivalSeqForTests();
    expect(arrivalSeqSettled()).toBe(0);
    await loadArrivalSeq();
    expect(arrivalSeqSettled()).toBeGreaterThanOrEqual(before.to);
  });
});
