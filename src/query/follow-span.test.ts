import { beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  clickhouseInsertJsonEachRow,
  pingClickHouse,
  toClickHouseDateTime,
} from "../shared/clickhouse";
import { migrateStore } from "../shared/migrate";
import { followEdgeMs, followOpened, followReachMs } from "../shared/follow-span";
import { followSpanRoute, followSpanWhere, searchFollowSpan } from "./follow-span";
import { search } from "./index";

const iso = (ms: number) => new Date(ms).toISOString();

function row(ms: number, service: string, attrs: Record<string, string>, message: string) {
  return JSON.stringify({
    tenant_id: "default",
    ts: toClickHouseDateTime(iso(ms)),
    service,
    host: "control-1",
    level: "warn",
    message,
    attrs: JSON.stringify(attrs),
    attr_map: attrs,
    trace_id: "",
  });
}

describe("followSpanWhere", () => {
  test("a day either side of the event and an hour past it, ANDed with the followed token", () => {
    const at = Date.parse("2026-10-15T06:20:41.118Z");
    const { sql, params } = followSpanWhere("sandbox_id:sandbox-41c9", at);
    expect(params.from).toBe(iso(at - followReachMs));
    expect(params.to).toBe(iso(at + followReachMs));
    expect(params.outer_from).toBe(iso(at - followReachMs - followEdgeMs));
    expect(params.outer_to).toBe(iso(at + followReachMs + followEdgeMs));
    expect(sql).toContain("ts >= parseDateTime64BestEffort({outer_from:String})");
    expect(sql).toContain("ts <= parseDateTime64BestEffort({outer_to:String})");
    expect(Object.values(params)).toContain("sandbox-41c9");
  });
});

describe("followSpanRoute", () => {
  const app = new Hono();
  app.get("/span", followSpanRoute);
  test("q and at are required", async () => {
    expect((await app.request("/span?q=a:b")).status).toBe(400);
    expect((await app.request("/span?at=2026-10-15T06:20:41Z")).status).toBe(400);
    expect((await app.request("/span?q=a:b&at=nope")).status).toBe(400);
  });
  test("a query that does not parse is a 400 with its faults", async () => {
    const res = await app.request(`/span?q=${encodeURIComponent('a:"b')}&at=2026-10-15T06:20:41Z`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { faults?: unknown[] }).faults?.length).toBeGreaterThan(0);
  });
});

describe("follow span ClickHouse", () => {
  beforeAll(async () => {
    process.env.CLICKHOUSE_USER ??= "default";
    process.env.CLICKHOUSE_PASSWORD ??= "toposcope";
    if (!(await pingClickHouse())) throw new Error("ClickHouse is required for follow span regressions");
    await migrateStore();
  });

  test("12 rows over 21 hours before the event open on those 21 hours, with every row", async () => {
    const tag = `${Date.now()}`;
    const sandbox = `sandbox-${tag}`;
    // The event followed from: the last webhook failure, two hours ago.
    const at = Math.floor((Date.now() - 2 * 3_600_000) / 1000) * 1000 + 118;
    const first = at - (21 * 3_600_000 + 8 * 60_000 + 38_118);
    const offsets = [0, 2_000, 4_000, 4_000, 7_204_000, 7_204_000, 21_604_000, 21_604_000, 46_804_000, 46_804_000];
    const rows = [
      row(first, `api${tag}`, { sandbox_id: sandbox }, `sandbox ${sandbox} deleted`),
      ...offsets.slice(1).map((d, i) =>
        row(first + d, `api${tag}`, { sandbox_id: sandbox, attempt: String(i) }, "webhook did not take sandbox.stopped"),
      ),
      row(at - 2_000, `api${tag}`, { sandbox_id: sandbox }, "last try, not sent again"),
      row(at, `api${tag}`, { sandbox_id: sandbox }, "last try, not sent again"),
      // More than a day either side, two hours past: not part of the story, and not read.
      row(at - followReachMs - 2 * followEdgeMs, `api${tag}`, { sandbox_id: sandbox }, "an older life"),
      row(at + followReachMs + 2 * followEdgeMs, `api${tag}`, { sandbox_id: sandbox }, "a later life"),
    ];
    await clickhouseInsertJsonEachRow(rows.join("\n"));

    const span = await searchFollowSpan(`sandbox_id:${sandbox}`, at);
    expect(span).toEqual({ n: 12, first: iso(first), last: iso(at) });

    const opened = followOpened(at, span);
    expect(opened.how).toBe("span");
    expect(opened.cut).toBeUndefined();
    expect(opened.fromMs).toBeLessThanOrEqual(first);
    expect(opened.toMs).toBeGreaterThan(at);
    expect(opened.toMs - opened.fromMs).toBeLessThan(21 * 3_600_000 + 10 * 60_000);

    const result = await search({
      q: `sandbox_id:${sandbox}`,
      from: iso(opened.fromMs),
      to: iso(opened.toMs),
      limit: 100,
    });
    expect(result.total).toBe(12);
    expect(result.events).toHaveLength(12);
  });

  test("a value still seen past a day before is cut at a day, and says so", async () => {
    const tag = `${Date.now()}`;
    const at = Date.now() - 3_600_000;
    const key = `account_id:acct_${tag}`;
    await clickhouseInsertJsonEachRow(
      [
        row(at - followReachMs - 30 * 60_000, `api${tag}`, { account_id: `acct_${tag}` }, "before the day"),
        row(at - followReachMs + 60_000, `api${tag}`, { account_id: `acct_${tag}` }, "a day ago"),
        row(at, `api${tag}`, { account_id: `acct_${tag}` }, "now"),
      ].join("\n"),
    );
    const span = await searchFollowSpan(key, at);
    expect(span.n).toBe(2);
    expect(span.pastBefore).toBe(true);
    expect(span.pastAfter).toBeUndefined();
    expect(followOpened(at, span).cut).toBe("before");
  });

  test("an id seen once opens ±5m around it", async () => {
    const tag = `${Date.now()}`;
    const at = Date.now() - 3_600_000;
    await clickhouseInsertJsonEachRow(row(at, `api${tag}`, { request_id: `req-${tag}` }, "POST /v1/sandboxes 500"));
    const span = await searchFollowSpan(`request_id:req-${tag}`, at);
    expect(span.n).toBe(1);
    const opened = followOpened(at, span);
    expect(opened.how).toBe("once");
    expect(opened.fromMs).toBeLessThanOrEqual(at - 300_000);
    expect(opened.toMs).toBeGreaterThanOrEqual(at + 300_000);
  });

  test("a value with no row in the day says so", async () => {
    const span = await searchFollowSpan(`request_id:nowhere-${Date.now()}`, Date.now());
    expect(span).toEqual({ n: 0, first: null, last: null });
  });
});
