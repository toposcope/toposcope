import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { getAlert, type AlertRule } from "../control/alerts";
import { migrateControlDb } from "../control/index";
import { insertPushMonitor, pushFieldsOfResult } from "../control/push-monitors";
import { isLate } from "../shared/push";
import type { WebhookOutcome } from "./delivery";
import type { CallDeps } from "./monitor";
import { lastPushResult, monitorHistory, openStretch, pruneResults, resultsBetween } from "./monitor-store";
import type { WebhookPayload } from "./payload";
import { applyPushResult, noteStart, passPushMonitor, type PushResult } from "./push";

const minute = 60_000;
const hour = 60 * minute;
const t0 = Date.parse("2026-10-20T10:00:00.000Z");

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
    r.push("warn", t0 + minute, { message: "/var 87% used", value: 87.2, unit: "%" });
    await r.pass(t0 + minute);
    expect(r.rule()).toMatchObject({ state: "ok", last_result: "warn", last_value: 87.2 });
    r.push("fail", t0 + 2 * minute, { message: "DISK CRITICAL - /var 96%" });
    await r.pass(t0 + 2 * minute);
    expect(r.rule().state).toBe("open");
    expect(openStretch(r.id, r.db)?.open_message).toBe("DISK CRITICAL - /var 96%");
    r.push("warn", t0 + 3 * minute);
    expect(r.rule().state).toBe("open");
    r.push("ok", t0 + 4 * minute);
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
    r.push("unknown", t0 + minute, { exit_code: 3 });
    expect(r.rule()).toMatchObject({ state: "ok", last_result: null });
    r.push("fail", t0 + 2 * minute, { exit_code: 2 });
    r.push("unknown", t0 + 3 * minute, { exit_code: 3 });
    expect(r.rule()).toMatchObject({ state: "open", last_result: "fail" });
    expect(lastPushResult(r.id, r.db)).toMatchObject({ status: "unknown", exit_code: 3 });
  });

  test("a result with no message opens with its status and exit code in words", () => {
    const r = rig();
    r.push("fail", t0 + minute, { exit_code: 2 });
    expect(openStretch(r.id, r.db)?.open_message).toBe("fail · exit 2");
  });

  test("a paused monitor keeps its results and does not open", () => {
    const r = rig();
    r.db.query("UPDATE alert_rules SET enabled = 0 WHERE id = ?").run(r.id);
    r.push("fail", t0 + minute);
    expect(r.rule()).toMatchObject({ state: "ok", last_result: "fail" });
    expect(lastPushResult(r.id, r.db)?.status).toBe("fail");
  });

  test("a result can set every and grace; left out, they stay", () => {
    const r = rig({ every: null, grace: null });
    r.push("ok", t0 + minute, { every_ms: 5 * minute, grace_ms: 2 * minute });
    expect(r.rule()).toMatchObject({ every_ms: 5 * minute, grace_ms: 2 * minute });
    r.push("ok", t0 + 2 * minute);
    expect(r.rule()).toMatchObject({ every_ms: 5 * minute, grace_ms: 2 * minute });
  });

  test("a run is measured from its /start, and is over at its result", () => {
    const r = rig();
    noteStart(r.id, t0, r.db);
    expect(r.rule().started_at).toBe(t0);
    r.push("ok", t0 + 4 * minute, { duration_ms: 4 * minute });
    expect(r.rule().started_at).toBeNull();
    expect(lastPushResult(r.id, r.db)?.duration_ms).toBe(4 * minute);
  });
});

describe("Watch's ticks (#177): one a monitor a minute, the worst winning, for 30 days", () => {
  test("a fail and then an ok in one minute keep the fail; an equal later one replaces it", () => {
    const r = rig();
    r.push("fail", t0 + 10_000, { exit_code: 2 });
    r.push("ok", t0 + 20_000);
    expect(resultsBetween(t0, t0 + minute, r.db).results.map((x) => [x.status, x.exit_code])).toEqual([["fail", 2]]);
    r.push("fail", t0 + 30_000, { exit_code: 1 });
    expect(resultsBetween(t0, t0 + minute, r.db).results.map((x) => [x.status, x.exit_code])).toEqual([["fail", 1]]);
  });

  test("a warn replaces an ok and an unknown; the next minute is a row of its own", () => {
    const r = rig();
    r.push("ok", t0 + 1000);
    r.push("unknown", t0 + 2000);
    r.push("warn", t0 + 3000);
    r.push("ok", t0 + minute + 1000);
    expect(resultsBetween(t0, t0 + 2 * minute, r.db).results.map((x) => x.status)).toEqual(["warn", "ok"]);
  });

  test("results older than 30 days go", () => {
    const r = rig();
    r.push("ok", t0);
    r.push("ok", t0 + 2 * minute);
    pruneResults(t0 + 30 * 24 * hour + minute, r.db);
    expect(resultsBetween(0, t0 + 31 * 24 * hour, r.db).results.map((x) => x.at)).toEqual([t0 + 2 * minute]);
  });
});

describe("a result that never comes (#177)", () => {
  test("with every 1h and grace 15m and nothing after, it is late at 1h and opens at 1h15m", async () => {
    const r = rig({ webhook: "https://hooks.example.com/page" });
    r.push("ok", t0);
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
      "missed: no result since 2026-10-20T10:00:00.000Z, due 2026-10-20T11:00:00.000Z",
    );
    expect(r.sent.map((c) => c.json.state)).toEqual(["open"]);
    // Still nothing: it stays open, and reminds every 4h, not every every.
    await r.pass(t0 + 3 * hour);
    expect(r.sent.map((c) => c.json.state)).toEqual(["open"]);
    r.push("ok", t0 + 3 * hour + minute);
    await r.pass(t0 + 3 * hour + minute);
    expect(r.rule().state).toBe("ok");
    expect(r.sent.map((c) => c.json.state)).toEqual(["open", "resolved"]);
  });

  test("without every it goes by its results alone and is never late", async () => {
    const r = rig({ every: null });
    r.push("ok", t0);
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
    r.push("fail", t0 + minute);
    await r.pass(t0 + minute);
    expect(r.sent.map((c) => c.url)).toEqual(["https://ntfy.sh/agental-ops"]);
  });

  test("with neither, it keeps its state and calls nobody, and its stretch says so", async () => {
    const r = rig();
    r.push("fail", t0 + minute);
    await r.pass(t0 + minute);
    expect(r.rule().state).toBe("open");
    r.push("ok", t0 + 2 * minute);
    await r.pass(t0 + 2 * minute);
    expect(r.rule().state).toBe("ok");
    expect(r.sent).toEqual([]);
    const [stretch] = monitorHistory(r.id, 1, r.db);
    expect(stretch).toMatchObject({ open_call: "none", resolved_call: "none" });
  });

  test("its own webhook wins over the default", async () => {
    const r = rig({ webhook: "https://hooks.example.com/own", fallback: "https://ntfy.sh/agental-ops" });
    r.push("fail", t0 + minute);
    await r.pass(t0 + minute);
    expect(r.sent.map((c) => c.url)).toEqual(["https://hooks.example.com/own"]);
  });
});
