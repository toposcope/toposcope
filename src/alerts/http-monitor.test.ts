import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeCerts, startStands, type Certs, type Stands } from "../../scripts/http-stands";
import { getAlert, recordWebhookAttempt } from "../control/alerts";
import { migrateControlDb } from "../control/index";
import type { LogEvent } from "../shared/log-event";
import type { MetricPoint } from "../shared/metric";
import { nextRunAt, tickHttpMonitors } from "./http-cron";
import { runHttpMonitor, type HttpMonitorDeps } from "./http-monitor";
import { runHttpRequest } from "./http-request";
import { getHttp, insertHttp, type HttpWrite } from "./http-store";
import { pingClickHouse } from "../shared/clickhouse";
import { migrateStore } from "../shared/migrate";
import { lastPushResult, recordPushResults, resultsBetween, type PushResultRow } from "./monitor-results";
import { monitorHistory, openStretch } from "./monitor-store";
import type { WebhookPayload } from "./payload";

let certs: Certs;
let stands: Stands;

beforeAll(() => {
  certs = makeCerts(20);
  stands = startStands(certs, { slowMs: 450 });
});

afterAll(() => {
  stands.stop();
  certs.cleanup();
});

// Near now, on the minute: results live in ClickHouse (#324) and a date past retention would age out.
const t0 = Math.floor((Date.now() - 2 * 24 * 60 * 60_000) / 3_600_000) * 3_600_000 + 3 * 60_000;

beforeAll(async () => {
  process.env.CLICKHOUSE_USER ??= "default";
  process.env.CLICKHOUSE_PASSWORD ??= "toposcope";
  if (!(await pingClickHouse())) throw new Error("ClickHouse is required for monitor results");
  await migrateStore();
});

function freshDb(): Database {
  const db = new Database(":memory:");
  migrateControlDb(db);
  return db;
}

// One run of the tests: results outlive the in-memory SQLite in ClickHouse (#324), so ids are this run's own, one a monitor.
const run = Date.now().toString(36);
let made = 0;
function addHttp(db: Database, w: Partial<HttpWrite> & { url: string }, over: Record<string, unknown> = {}): string {
  const row: Record<string, unknown> = {
    id: `http-${++made}-${run}`,
    name: "api /health",
    query: "",
    webhook_url: "https://hooks.example.com/page",
    saved_search_id: null,
    threshold: 1,
    enabled: 1,
    created_at: t0 - 60_000,
    kind: "http",
    body_kind: "default",
    body_template: null,
    source: "http",
    remind_every: "4h",
    resolved_body: null,
    ...over,
  };
  const cols = Object.keys(row);
  db.query(`INSERT INTO alert_rules (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(
    ...(Object.values(row) as Array<string | number | null>),
  );
  insertHttp(
    row.id as string,
    { method: "GET", body: null, headers: [], every_ms: 30_000, conditions: "", fail_after: 2, ...w },
    t0,
    db,
  );
  return row.id as string;
}

/** A monitor's runs, rows, metrics and calls, with the clock in the test's hand. */
function rig(db: Database) {
  const rows: LogEvent[] = [];
  const metrics: MetricPoint[] = [];
  const calls: Array<{ url: string; json: Record<string, unknown> }> = [];
  const deps: HttpMonitorDeps = {
    db,
    request: (input) => runHttpRequest({ ...input, ca: certs.ca, timeoutMs: input.timeoutMs }),
    write: async (row, metric) => {
      rows.push(row);
      if (metric) {
        metrics.push(metric);
      }
    },
    post: async (url: string, payload: WebhookPayload) => {
      calls.push({ url, json: JSON.parse(payload.body) as Record<string, unknown> });
      return { ok: true, status: "200", error: null };
    },
    publicUrl: () => "https://logs.example.com",
    recordWebhook: (id, attempt, database) => recordWebhookAttempt(id, attempt, database),
  };
  const run = async (id: string, at: number) => runHttpMonitor(getAlert(id, db)!, getHttp(id, db)!, at, deps);
  return { rows, metrics, calls, deps, run };
}

describe("an HTTP(S) monitor", () => {
  test("opens after two 503s in a row, and resolves on the next 200", async () => {
    const db = freshDb();
    const id = addHttp(db, { url: `${stands.http}/flip` });
    const r = rig(db);
    stands.flip(503);
    await r.run(id, t0);
    expect(getAlert(id, db)!.state).toBe("ok");
    expect(getHttp(id, db)!.fails_in_row).toBe(1);
    expect(r.calls).toHaveLength(0);
    await r.run(id, t0 + 30_000);
    expect(getAlert(id, db)!.state).toBe("open");
    expect(openStretch(id, db)!.open_message).toBe("status is 503, not 2xx");
    expect(r.calls.map((c) => c.json.state)).toEqual(["open"]);
    expect(r.calls[0]!.json).toMatchObject({
      alert: { id, name: "api /health", source: "http" },
      url: `${stands.http}/flip`,
      status: 503,
      message: "status is 503, not 2xx",
    });
    stands.flip(200);
    await r.run(id, t0 + 60_000);
    expect(getAlert(id, db)!.state).toBe("ok");
    expect(getHttp(id, db)!.fails_in_row).toBe(0);
    expect(r.calls.map((c) => c.json.state)).toEqual(["open", "resolved"]);
    const [stretch] = monitorHistory(id, 5, db);
    expect(stretch).toMatchObject({ opened_at: t0 + 30_000, resolved_at: t0 + 60_000, closed_by: "ok" });
    expect(r.calls[1]!.json.link).toContain("q=monitor%3A%22api+%2Fhealth%22");
    // Every run is a row.
    expect(r.rows.map((row) => [row.level, row.attrs!.status, row.attrs!["http.status"]])).toEqual([
      ["error", "fail", 503],
      ["error", "fail", 503],
      ["info", "ok", 200],
    ]);
  });

  test("without a webhook of its own it calls the default; with neither it keeps its state and calls nobody", async () => {
    const db = freshDb();
    const own = addHttp(db, { url: `${stands.http}/down`, fail_after: 1 }, { id: "http-default", name: "uses the default", webhook_url: null });
    const r = rig(db);
    r.deps.defaultWebhook = () => "https://ntfy.example.com/ops";
    await r.run(own, t0);
    expect(getAlert(own, db)!.state).toBe("open");
    expect(r.calls.map((c) => [c.url, c.json.state])).toEqual([["https://ntfy.example.com/ops", "open"]]);

    const none = addHttp(db, { url: `${stands.http}/down`, fail_after: 1 }, { id: "http-nobody", name: "calls nobody", webhook_url: null });
    r.deps.defaultWebhook = () => null;
    await r.run(none, t0);
    expect(getAlert(none, db)!.state).toBe("open");
    expect(openStretch(none, db)!.open_call).toBe("none");
    expect(r.calls).toHaveLength(1);
  });

  test("one 503 between 200s does not open it", async () => {
    const db = freshDb();
    const id = addHttp(db, { url: `${stands.http}/flip` });
    const r = rig(db);
    stands.flip(200);
    await r.run(id, t0);
    stands.flip(503);
    await r.run(id, t0 + 30_000);
    stands.flip(200);
    await r.run(id, t0 + 60_000);
    stands.flip(503);
    await r.run(id, t0 + 90_000);
    expect(getAlert(id, db)!.state).toBe("ok");
    expect(monitorHistory(id, 5, db)).toHaveLength(0);
  });

  test('$.db == "ok" fails on {"db":"down"}, and the row names that line', async () => {
    const db = freshDb();
    const id = addHttp(db, { url: `${stands.http}/db-down`, conditions: 'status == 200\n$.db == "ok"', fail_after: 1 });
    const r = rig(db);
    const run = await r.run(id, t0);
    expect(run.verdict).toMatchObject({ result: "fail", line: '$.db == "ok"', why: '$.db is "down", not "ok"' });
    const row = r.rows[0]!;
    expect(row).toMatchObject({ service: "toposcope", level: "error", message: 'api /health fail · $.db is "down", not "ok"' });
    expect(row.attrs).toMatchObject({
      monitor: "api /health",
      status: "fail",
      source: "http",
      "http.status": 200,
      line: '$.db == "ok"',
      error: '$.db is "down", not "ok"',
    });
    expect(typeof row.attrs!.duration_ms).toBe("number");
    expect(r.metrics).toEqual([
      { ts: row.ts, name: "monitor_duration_ms", value: row.attrs!.duration_ms as number, labels: { monitor: "api /health", source: "http" } },
    ]);
    expect(getAlert(id, db)!.state).toBe("open");
  });

  test("a warn line over its time warns, and never opens it", async () => {
    const db = freshDb();
    const id = addHttp(db, { url: `${stands.http}/slow`, conditions: "status == 200\ntime < 300ms   warn", fail_after: 1 });
    const r = rig(db);
    for (let i = 0; i < 3; i++) {
      const run = await r.run(id, t0 + i * 30_000);
      expect(run.verdict.result).toBe("warn");
    }
    expect(getAlert(id, db)).toMatchObject({ state: "ok", last_result: "warn" });
    expect(getHttp(id, db)!.fails_in_row).toBe(0);
    expect(r.rows.map((row) => row.level)).toEqual(["warn", "warn", "warn"]);
    expect(r.rows[0]!.attrs).toMatchObject({ status: "warn", line: "time < 300ms" });
    expect(r.calls).toHaveLength(0);
  });

  test("cert > 30d fails on a certificate with 20 days left", async () => {
    const db = freshDb();
    const id = addHttp(db, { url: `${stands.https}/health`, conditions: "cert > 30d", fail_after: 1 });
    const r = rig(db);
    const run = await r.run(id, t0);
    expect(run.verdict).toMatchObject({ result: "fail", line: "cert > 30d" });
    expect(run.verdict.why).toMatch(/^certificate expires in (19|20) days$/);
    expect(getHttp(id, db)!.last_run!.cert_valid_to).toBeTruthy();
    const ok = addHttp(db, { url: `${stands.https}/health`, conditions: "cert > 14d" }, { id: "http-2", name: "cert ok" });
    expect((await r.run(ok, t0)).verdict.result).toBe("ok");
  });

  test("a URL that redirects off its host is a fail, and is not followed", async () => {
    const db = freshDb();
    const id = addHttp(db, { url: `${stands.http}/redirect`, fail_after: 1 });
    const r = rig(db);
    const run = await r.run(id, t0);
    expect(run.verdict).toMatchObject({
      result: "fail",
      why: "redirects to https://example.com/elsewhere, not followed",
    });
    expect(stands.hits.get("/elsewhere")).toBeUndefined();
  });

  test("nothing listening: the row says connect ECONNREFUSED, and no time is kept as a metric", async () => {
    const db = freshDb();
    const free = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = free.port;
    free.stop(true);
    const id = addHttp(db, { url: `http://127.0.0.1:${port}/health`, conditions: "status == 200" });
    const r = rig(db);
    await r.run(id, t0);
    expect(r.rows[0]).toMatchObject({ level: "error", message: "api /health fail · connect ECONNREFUSED" });
    expect(r.rows[0]!.attrs!.error).toBe("connect ECONNREFUSED");
    expect(r.rows[0]!.attrs!["http.status"]).toBeUndefined();
    expect(r.metrics).toHaveLength(0);
  });

  test("a POST sends its body and its headers", async () => {
    const db = freshDb();
    const id = addHttp(db, {
      url: `${stands.http}/echo`,
      method: "POST",
      body: '{"ping":1}',
      headers: [["Authorization", "Bearer s3cret"]],
      conditions: '$.body == "{\\"ping\\":1}"',
    });
    const r = rig(db);
    expect((await r.run(id, t0)).verdict.result).toBe("ok");
    expect(stands.last.get("/echo")?.headers.authorization).toBe("Bearer s3cret");
    // A header is sent, never written to the row.
    expect(JSON.stringify(r.rows[0])).not.toContain("s3cret");
  });

  test("its row is written even when ClickHouse is down, and it still opens", async () => {
    const db = freshDb();
    const id = addHttp(db, { url: `${stands.http}/down`, fail_after: 1 });
    const r = rig(db);
    r.deps.write = async () => {
      throw new Error("ClickHouse is down");
    };
    await r.run(id, t0);
    expect(getAlert(id, db)!.state).toBe("open");
  });
});

describe("its own clock", () => {
  test("a run keeps its pace, or starts over from now when it fell behind", () => {
    expect(nextRunAt(t0, 30_000, t0 + 400)).toBe(t0 + 30_000);
    expect(nextRunAt(t0, 30_000, t0 + 5 * 60_000)).toBe(t0 + 5 * 60_000 + 30_000);
    expect(nextRunAt(null, 60_000, t0)).toBe(t0 + 60_000);
  });

  test("each due, enabled monitor runs once a tick; a paused one does not run", async () => {
    const db = freshDb();
    const due = addHttp(db, { url: `${stands.http}/health` });
    const paused = addHttp(db, { url: `${stands.http}/health` }, { id: "http-paused", name: "paused", enabled: 0 });
    const r = rig(db);
    const before = stands.hits.get("/health") ?? 0;
    await tickHttpMonitors(t0, r.deps);
    expect(getHttp(due, db)!.next_run_at).toBe(t0 + 30_000);
    expect(getHttp(due, db)!.last_run).toMatchObject({ at: t0, result: "ok", status: 200 });
    expect(getHttp(paused, db)!.last_run).toBeNull();
    // Not due again until its next run.
    await tickHttpMonitors(t0 + 10_000, r.deps);
    expect(stands.hits.get("/health")! - before).toBe(1);
    await tickHttpMonitors(t0 + 30_000, r.deps);
    expect(stands.hits.get("/health")! - before).toBe(2);
  });
});

describe("Watch's ticks (monitor_results)", () => {
  test("each run is a result row: the worst of its minute wins, of equals the later", async () => {
    const db = freshDb();
    const id = addHttp(db, { url: `${stands.http}/flip`, fail_after: 5 });
    const r = rig(db);
    const minute = Math.floor(t0 / 60_000) * 60_000;
    stands.flip(200);
    await r.run(id, minute + 1_000);
    stands.flip(503);
    await r.run(id, minute + 31_000);
    stands.flip(200);
    // A later ok in the same minute does not hide the fail.
    await r.run(id, minute + 50_000);
    await r.run(id, minute + 61_000);
    await r.run(id, minute + 91_000);
    const rows = (await resultsBetween(minute, minute + 120_000)).filter((row) => row.monitor_id === id);
    expect(rows.map((row) => [row.at - minute, row.result, row.via, row.host])).toEqual([
      [31_000, "fail", "http", new URL(stands.http).host],
      [91_000, "ok", "http", new URL(stands.http).host],
    ]);
    expect(rows[0]!.message).toBe("status is 503, not 2xx");
    expect(typeof rows[1]!.duration_ms).toBe("number");
    // Every run is kept (#324); the minute's worst is what is read, and the last minute's for its last.
    expect(await lastPushResult(id)).toMatchObject({ result: "ok", at: minute + 91_000 });
  });

  test("a lane is read in 240 columns, the worst of each", async () => {
    const db = freshDb();
    const id = addHttp(db, { url: `${stands.http}/health` });
    const day = 24 * 60 * 60_000;
    const from = t0 - day;
    const runs: Array<Omit<PushResultRow, "id">> = [];
    for (let i = 0; i < 24 * 60; i++) {
      // One run a minute for a day; one warn and one fail in the same 6-minute column.
      const result = i === 600 ? "warn" : i === 602 ? "fail" : "ok";
      runs.push({ monitor_id: id, at: from + i * 60_000 + 5_000, result, exit_code: null, duration_ms: 10, value: null, unit: null, message: result, host: "h", via: "http" });
    }
    await recordPushResults(runs);
    const lane = (await resultsBetween(from, t0)).filter((row) => row.monitor_id === id);
    expect(lane).toHaveLength(240);
    expect(lane.filter((row) => row.result !== "ok").map((row) => row.result)).toEqual(["fail"]);
  }, 120_000);
});
