import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { getAlert, type AlertRule } from "../control/alerts";
import { migrateControlDb } from "../control/index";
import { insertPushMonitor, pushFieldsOfResult } from "../control/push-monitors";
import { isLate } from "../shared/push";
import type { WebhookOutcome } from "./delivery";
import type { CallDeps } from "./monitor";
import { clickhouseQuery, pingClickHouse } from "../shared/clickhouse";
import { migrateStore } from "../shared/migrate";
import { lastPushResult, resultsBetween } from "./monitor-results";
import { monitorHistory, openStretch } from "./monitor-store";
import type { WebhookPayload } from "./payload";
import { applyPushResult, noteStart, passPushMonitor, type PushResult } from "./push";

const minute = 60_000;
const hour = 60 * minute;
// Near now, on the hour: results live in ClickHouse (#324) and a date past retention would age out.
const t0 = Math.floor((Date.now() - 2 * 24 * hour) / hour) * hour;

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

function result(status: PushResult["status"], over: Partial<PushResult> = {}): PushResult {
  return {
    monitor: "nightly-backup",
    status,
    message: "",
    value: null,
    unit: null,
    host: "",
    service: "monitor",
    ts: new Date(t0).toISOString(),
    exit_code: null,
    duration_ms: null,
    via: "checks",
    from: "",
    ...over,
  };
}

/** A push monitor, its calls, and a default webhook, with the clock in the test's hand. */
function rig(opts: { webhook?: string | null; fallback?: string | null; every?: number | null; grace?: number | null } = {}) {
  const db = freshDb();
  const made = insertPushMonitor(
    {
      ...pushFieldsOfResult("nightly-backup", opts.every === undefined ? hour : opts.every, opts.grace === undefined ? 15 * minute : opts.grace),
      webhook_url: opts.webhook ?? null,
    },
    t0,
    db,
  ) as AlertRule;
  const sent: Array<{ url: string; json: Record<string, unknown> }> = [];
  const deps: CallDeps = {
    db,
    post: async (url: string, payload: WebhookPayload): Promise<WebhookOutcome> => {
      sent.push({ url, json: JSON.parse(payload.body) as Record<string, unknown> });
      return { ok: true, status: "200", error: null };
    },
    publicUrl: () => "https://logs.example.com",
    recordWebhook: () => undefined,
    defaultWebhook: () => opts.fallback ?? null,
  };
  const rule = () => getAlert(made.id, db)!;
  const push = (status: PushResult["status"], at: number, over: Partial<PushResult> = {}) =>
    applyPushResult(rule(), result(status, { ts: new Date(at).toISOString(), ...over }), at, db);
  const pass = (at: number) => passPushMonitor(made.id, at, deps);
  return { db, id: made.id, rule, push, pass, sent };
}

describe("a push monitor's results (#177)", () => {
  test("a fail opens it, a warn shows and does not open, the next ok resolves it", async () => {
    const r = rig({ webhook: "https://hooks.example.com/page" });
    await r.push("warn", t0 + minute, { message: "/var 87% used", value: 87.2, unit: "%" });
    await r.pass(t0 + minute);
    expect(r.rule()).toMatchObject({ state: "ok", last_result: "warn", last_value: 87.2 });
    await r.push("fail", t0 + 2 * minute, { message: "DISK CRITICAL - /var 96%" });
    await r.pass(t0 + 2 * minute);
    expect(r.rule().state).toBe("open");
    expect(openStretch(r.id, r.db)?.open_message).toBe("DISK CRITICAL - /var 96%");
    await r.push("warn", t0 + 3 * minute);
    expect(r.rule().state).toBe("open");
    await r.push("ok", t0 + 4 * minute);
    await r.pass(t0 + 4 * minute);
    expect(r.rule().state).toBe("ok");
    expect(r.sent.map((c) => c.json.state)).toEqual(["open", "resolved"]);
    expect(r.sent[0]!.json).toMatchObject({
      alert: { id: r.id, name: "nightly-backup", source: "push" },
      query: "monitor:nightly-backup",
      message: "DISK CRITICAL - /var 96%",
    });
    expect(String(r.sent[0]!.json.link)).toContain("q=monitor%3Anightly-backup");
  });

  test("unknown changes nothing: it neither opens nor resolves, and is not its last result", async () => {
    const r = rig();
    await r.push("unknown", t0 + minute, { exit_code: 3 });
    expect(r.rule()).toMatchObject({ state: "ok", last_result: null });
    await r.push("fail", t0 + 2 * minute, { exit_code: 2 });
    await r.push("unknown", t0 + 3 * minute, { exit_code: 3 });
    expect(r.rule()).toMatchObject({ state: "open", last_result: "fail" });
    // Nor is it a tick on Watch: its log row is its record.
    expect((await lastPushResult(r.id))).toMatchObject({ result: "fail", exit_code: 2 });
  });

  test("a result with no message opens with its status and exit code in words", async () => {
    const r = rig();
    await r.push("fail", t0 + minute, { exit_code: 2 });
    expect(openStretch(r.id, r.db)?.open_message).toBe("fail · exit 2");
  });

  test("a paused monitor keeps its results and does not open", async () => {
    const r = rig();
    r.db.query("UPDATE alert_rules SET enabled = 0 WHERE id = ?").run(r.id);
    await r.push("fail", t0 + minute);
    expect(r.rule()).toMatchObject({ state: "ok", last_result: "fail" });
    expect((await lastPushResult(r.id))?.result).toBe("fail");
  });

  test("a result can set every and grace; left out, they stay", async () => {
    const r = rig({ every: null, grace: null });
    await r.push("ok", t0 + minute, { every_ms: 5 * minute, grace_ms: 2 * minute });
    expect(r.rule()).toMatchObject({ every_ms: 5 * minute, grace_ms: 2 * minute });
    await r.push("ok", t0 + 2 * minute);
    expect(r.rule()).toMatchObject({ every_ms: 5 * minute, grace_ms: 2 * minute });
  });

  test("a run is measured from its /start, and is over at its result", async () => {
    const r = rig();
    noteStart(r.id, t0, r.db);
    expect(r.rule().started_at).toBe(t0);
    await r.push("ok", t0 + 4 * minute, { duration_ms: 4 * minute });
    expect(r.rule().started_at).toBeNull();
    expect((await lastPushResult(r.id))?.duration_ms).toBe(4 * minute);
  });
});

describe("Watch's ticks (#177): one a monitor a minute, the worst winning, for 30 days", () => {
  // One monitor's ticks as Watch reads them, around t0.
  const rows = async (id: string) =>
    (await resultsBetween(t0 - hour, t0 + hour))
      .filter((x) => x.monitor_id === id)
      .map(({ result, exit_code }) => ({ result, exit_code }));

  test("a fail and then an ok in one minute keep the fail; an equal later one replaces it", async () => {
    const r = rig();
    await r.push("fail", t0 + 10_000, { exit_code: 2 });
    await r.push("ok", t0 + 20_000);
    expect(await rows(r.id)).toEqual([{ result: "fail", exit_code: 2 }]);
    await r.push("fail", t0 + 30_000, { exit_code: 1 });
    expect(await rows(r.id)).toEqual([{ result: "fail", exit_code: 1 }]);
  });

  test("a warn replaces an ok, an unknown is not kept, and the next minute is a row of its own", async () => {
    const r = rig();
    await r.push("ok", t0 + 1000);
    await r.push("warn", t0 + 2000);
    await r.push("unknown", t0 + minute + 1000);
    await r.push("ok", t0 + 2 * minute + 1000);
    expect((await rows(r.id)).map((x) => x.result)).toEqual(["warn", "ok"]);
  });

  test("results follow retention by TTL, not a sweep of their own", async () => {
    const rows = await clickhouseQuery<{ engine_full: string }>(
      "SELECT engine_full FROM system.tables WHERE database = currentDatabase() AND name = 'monitor_results'",
    );
    expect(rows[0]?.engine_full).toMatch(/TTL toDate\(at\) \+ toIntervalDay\(\d+\)/);
  });

  test("Watch reads them in at most 240 columns a lane, each the worst of its column, the later of equals", async () => {
    const r = rig({ every: 5 * minute });
    // A day of results every 5 minutes: 288, in 240 columns of 6 minutes.
    for (let k = 0; k < 288; k++) {
      await r.push(k === 6 ? "warn" : "ok", t0 + k * 5 * minute, { exit_code: k });
    }
    const read = (await resultsBetween(t0, t0 + 24 * hour)).filter((x) => x.monitor_id === r.id);
    expect(read.length).toBeLessThanOrEqual(240);
    expect(read.length).toBeGreaterThan(200);
    // 30m and 35m share the column from 30m to 36m: the warn wins over the later ok.
    expect(read.filter((x) => x.result === "warn").map((x) => x.exit_code)).toEqual([6]);
    expect(read.some((x) => x.exit_code === 7)).toBe(false);
    // 0m and 5m share the first column, both ok: the later.
    expect(read[0]!.exit_code).toBe(1);
  }, 60_000);
});

describe("a result that never comes (#177)", () => {
  test("with every 1h and grace 15m and nothing after, it is late at 1h and opens at 1h15m", async () => {
    const r = rig({ webhook: "https://hooks.example.com/page" });
    await r.push("ok", t0);
    await r.pass(t0 + hour);
    expect(isLate(r.rule(), t0 + hour)).toBe(false);
    await r.pass(t0 + hour + minute);
    expect(isLate(r.rule(), t0 + hour + minute)).toBe(true);
    expect(r.rule().state).toBe("ok");
    expect(r.sent).toEqual([]);
    await r.pass(t0 + hour + 14 * minute);
    expect(r.rule().state).toBe("ok");
    await r.pass(t0 + hour + 15 * minute);
    expect(r.rule().state).toBe("open");
    const stretch = openStretch(r.id, r.db)!;
    expect(stretch.due_at).toBe(t0 + hour);
    expect(stretch.opened_at).toBe(t0 + hour + 15 * minute);
    expect(stretch.open_message).toBe(
      `missed: no result since ${new Date(t0).toISOString()}, due ${new Date(t0 + hour).toISOString()}`,
    );
    expect(r.sent.map((c) => c.json.state)).toEqual(["open"]);
    // Still nothing: it stays open, and reminds every 4h, not every every.
    await r.pass(t0 + 3 * hour);
    expect(r.sent.map((c) => c.json.state)).toEqual(["open"]);
    await r.push("ok", t0 + 3 * hour + minute);
    await r.pass(t0 + 3 * hour + minute);
    expect(r.rule().state).toBe("ok");
    expect(r.sent.map((c) => c.json.state)).toEqual(["open", "resolved"]);
  });

  test("without every it goes by its results alone and is never late", async () => {
    const r = rig({ every: null });
    await r.push("ok", t0);
    await r.pass(t0 + 400 * 24 * hour);
    expect(r.rule().state).toBe("ok");
    expect(isLate(r.rule(), t0 + 400 * 24 * hour)).toBe(false);
  });

  test("a paused one is never late, and resumed it counts from then", async () => {
    const r = rig();
    r.db.query("UPDATE alert_rules SET enabled = 0 WHERE id = ?").run(r.id);
    await r.pass(t0 + 3 * hour);
    expect(r.rule().state).toBe("ok");
    expect(isLate(r.rule(), t0 + 3 * hour)).toBe(false);
  });

  test("before its first result it counts from when it was made", async () => {
    const r = rig();
    await r.pass(t0 + hour + 15 * minute);
    expect(r.rule().state).toBe("open");
  });
});

describe("who a push monitor calls (#177)", () => {
  test("with no webhook of its own it calls the default from Settings", async () => {
    const r = rig({ fallback: "https://ntfy.sh/agental-ops" });
    await r.push("fail", t0 + minute);
    await r.pass(t0 + minute);
    expect(r.sent.map((c) => c.url)).toEqual(["https://ntfy.sh/agental-ops"]);
  });

  test("with neither, it keeps its state and calls nobody, and its stretch says so", async () => {
    const r = rig();
    await r.push("fail", t0 + minute);
    await r.pass(t0 + minute);
    expect(r.rule().state).toBe("open");
    await r.push("ok", t0 + 2 * minute);
    await r.pass(t0 + 2 * minute);
    expect(r.rule().state).toBe("ok");
    expect(r.sent).toEqual([]);
    const [stretch] = monitorHistory(r.id, 1, r.db);
    expect(stretch).toMatchObject({ open_call: "none", resolved_call: "none" });
  });

  test("its own webhook wins over the default", async () => {
    const r = rig({ webhook: "https://hooks.example.com/own", fallback: "https://ntfy.sh/agental-ops" });
    await r.push("fail", t0 + minute);
    await r.pass(t0 + minute);
    expect(r.sent.map((c) => c.url)).toEqual(["https://hooks.example.com/own"]);
  });
});
