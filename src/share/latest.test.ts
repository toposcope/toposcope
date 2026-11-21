import { beforeAll, describe, expect, test } from "bun:test";
import { clickhouseInsertJsonEachRow, pingClickHouse } from "../shared/clickhouse";
import { migrateStore } from "../shared/migrate";

// Names of this run only, so reruns on one ClickHouse do not read each other's points.
const run = `latest_test_${Date.now().toString(36)}`;
const signUps = `${run}.sign_ups`;
const paying = `${run}.paying`;
const many = `${run}.many`;

type Read = { status: number; body: Record<string, unknown> };
let reads: Record<string, Read>;

function ts(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString().replace("T", " ").replace("Z", "");
}

beforeAll(async () => {
  process.env.CLICKHOUSE_USER ??= "default";
  process.env.CLICKHOUSE_PASSWORD ??= "toposcope";
  if (!(await pingClickHouse())) throw new Error("ClickHouse is required for share latest reads");
  await migrateStore();
  const day = 86_400_000;
  const rows: Record<string, unknown>[] = [
    // 2026-11-03 sent twice; the newer point (a refund) wins.
    { name: signUps, ts: ts(10 * 60_000), value: 4, labels: { service: "payroll", day: "2026-11-03" } },
    { name: signUps, ts: ts(5 * 60_000), value: 3, labels: { service: "payroll", day: "2026-11-03" } },
    { name: signUps, ts: ts(5 * 60_000), value: 7, labels: { service: "payroll", day: "2026-11-04" } },
    // 20 days ago: inside a 400d lookback, outside 10d. (Older would be past the table's own TTL.)
    { name: signUps, ts: ts(20 * day), value: 1, labels: { service: "payroll", day: "2026-10-30" } },
    // Outside the scope's labels: never read.
    { name: signUps, ts: ts(60_000), value: 99, labels: { service: "other", day: "2026-11-03" } },
    // No `day` label: not a row.
    { name: signUps, ts: ts(60_000), value: 5, labels: { service: "payroll" } },
    { name: paying, ts: ts(60_000), value: 2, labels: { service: "payroll", source: "x", cohort: "2026-W45" } },
    { name: paying, ts: ts(60_000), value: 5, labels: { service: "payroll", source: "all", cohort: "2026-W45" } },
    { name: paying, ts: ts(60_000), value: 9, labels: { service: "payroll", source: "all", cohort: "all" } },
  ];
  for (let i = 0; i < 2001; i++) {
    rows.push({ name: many, ts: ts(60_000), value: i, labels: { service: "payroll", day: `d${i}` } });
  }
  await clickhouseInsertJsonEachRow(rows.map((r) => JSON.stringify({ tenant_id: "default", ...r })).join("\n"), "metrics");

  const script = `
    const root = ${JSON.stringify(import.meta.dir)} + "/..";
    const { Hono } = await import("hono");
    const { shareAuth } = await import(root + "/share/operator.ts");
    const { shareReadCache, shareLatestRoute } = await import(root + "/share/read.ts");
    const { putShare } = await import(root + "/share/store.ts");
    const { parseShareScope } = await import(root + "/share/scope.ts");
    const { defaultShareLimits } = await import(root + "/share/limits.ts");
    const { defaultShareEmbed } = await import(root + "/share/embed.ts");
    const app = new Hono();
    app.use("/share/*", shareAuth);
    app.get("/share/v1/*", shareReadCache);
    app.get("/share/v1/latest", shareLatestRoute);
    const scope = parseShareScope({ metric_names: [${JSON.stringify(run + ".*")}], metric_labels: "service:payroll", narrow: ["day", "source", "cohort"] });
    const base = { scope, embed: defaultShareEmbed, expires_at: Date.now() + 86400000, panels: [], raw_params: true };
    const wide = putShare({ ...base, name: "latest-wide", limits: { ...defaultShareLimits, max_lookback: "400d" } }).secret;
    const tight = putShare({ ...base, name: "latest-tight", limits: { ...defaultShareLimits, reads_per_minute: 1 } }).secret;
    const plain = putShare({ ...base, name: "latest-plain", limits: defaultShareLimits }).secret;
    const off = putShare({ ...base, name: "latest-off", limits: defaultShareLimits, raw_params: false }).secret;
    const get = async (secret, path) => { const r = await app.request(path, { headers: { authorization: "Bearer " + secret } }); return { status: r.status, body: await r.json() }; };
    const out = {
      days: await get(wide, "/share/v1/latest?metric=${signUps}&by=day&lookback=400d"),
      recent: await get(wide, "/share/v1/latest?metric=${signUps}&by=day&lookback=10d"),
      funnel: await get(wide, "/share/v1/latest?metric=${paying},${signUps}&by=source,cohort&lookback=30d"),
      narrowed: await get(wide, "/share/v1/latest?metric=${paying}&by=cohort&ml=source:all&lookback=30d"),
      tooFar: await get(plain, "/share/v1/latest?metric=${signUps}&by=day&lookback=400d"),
      capped: await get(wide, "/share/v1/latest?metric=${many}&by=day&lookback=30d"),
      first: await get(tight, "/share/v1/latest?metric=${signUps}&by=day&lookback=30d"),
      again: await get(tight, "/share/v1/latest?metric=${signUps}&by=day&lookback=29d"),
      off: await get(off, "/share/v1/latest?metric=${signUps}&by=day&lookback=30d"),
    };
    console.log(JSON.stringify(out));
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", script], {
    env: { ...process.env, SQLITE_PATH: ":memory:" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (child.exitCode !== 0) {
    throw new Error(child.stderr.toString());
  }
  reads = JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!);
});

describe("GET /share/v1/latest", () => {
  test("one row per day: the newest point's value and time, inside the scope's labels", () => {
    expect(reads.days!.status).toBe(200);
    const body = reads.days!.body as { metrics: string[]; by: string[]; lookback: string; rows: Record<string, unknown>[] };
    expect(body.metrics).toEqual([signUps]);
    expect(body.by).toEqual(["day"]);
    expect(body.lookback).toBe("400d");
    expect(body.rows.map(({ day, value }) => ({ day, value }))).toEqual([
      { day: "2026-10-30", value: 1 },
      { day: "2026-11-03", value: 3 },
      { day: "2026-11-04", value: 7 },
    ]);
    expect(body.rows.every((r) => r.metric === signUps && typeof r.at === "string" && String(r.at).endsWith("Z"))).toBe(true);
    expect(reads.recent!.body.rows).toHaveLength(2);
  });

  test("several names and several labels at once; a narrowing picks one source", () => {
    const rows = reads.funnel!.body.rows as Record<string, unknown>[];
    // sign_ups has no source or cohort: no rows of its own.
    expect(rows.map(({ metric, source, cohort, value }) => ({ metric, source, cohort, value }))).toEqual([
      { metric: paying, source: "all", cohort: "2026-W45", value: 5 },
      { metric: paying, source: "all", cohort: "all", value: 9 },
      { metric: paying, source: "x", cohort: "2026-W45", value: 2 },
    ]);
    expect((reads.narrowed!.body.rows as Record<string, unknown>[]).map((r) => [r.cohort, r.value])).toEqual([
      ["2026-W45", 5],
      ["all", 9],
    ]);
  });

  test("refuses past max_lookback, past the row cap, and on a panels-only share", () => {
    expect(reads.tooFar!).toEqual({ status: 400, body: { error: "this share reaches back 30d" } });
    expect(reads.capped!.status).toBe(400);
    expect(String(reads.capped!.body.error)).toContain("more than 2,000 rows");
    expect(reads.off!.status).toBe(400);
  });

  test("counts as one read against reads_per_minute", () => {
    expect(reads.first!.status).toBe(200);
    expect(reads.again!.status).toBe(429);
  });
});
