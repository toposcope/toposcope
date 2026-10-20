import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { monitorLoop, monitorTick } from "./cron";
import { pingWatchdog, watchdogFailUrl, watchdogUrl, watchdogUrlError } from "./watchdog";

const root = join(import.meta.dir, "..");

/**
 * The monitor loop as the app runs it, in its own process: SQLite in memory, ClickHouse and every
 * webhook answered by this file's fake `fetch`. `body` runs after one monitor on `service:api`
 * (15m, at least 1) is set up; whatever it prints last is the result.
 */
function runLoop(body: string, env: Record<string, string> = {}): any {
  const script = `
    const root = ${JSON.stringify(root)};
    const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
    const state = { calls: [], chDown: false, chMs: 0, hookMs: 0, reads: 0 };
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.startsWith("http://clickhouse.test")) {
        if (state.chDown) throw new Error("connect ECONNREFUSED");
        if (u.includes("/ping")) return new Response("Ok.");
        state.reads++;
        await sleep(state.chMs);
        return Response.json({ data: [{ n: "5", ok: 1 }] });
      }
      if (u.startsWith("http://hook.test") || u.startsWith("http://watchdog.test")) {
        const text = init?.body ? String(init.body) : "";
        state.calls.push({ url: u, method: init?.method ?? "GET", state: text.startsWith("{") ? JSON.parse(text).state : null });
        await sleep(state.hookMs);
        return new Response("ok");
      }
      throw new Error("Unexpected external fetch " + u);
    };
    const { getDb } = await import(root + "/control/index.ts");
    const db = getDb();
    db.query("INSERT INTO saved_searches (id, name, query, created_at, range) VALUES ('s1', 'api errors', 'service:api', 0, '15m')").run();
    db.query(
      "INSERT INTO alert_rules (id, name, query, webhook_url, saved_search_id, threshold, enabled, created_at, kind, source, remind_every) VALUES ('m1', 'api errors', 'service:api', 'http://hook.test/page', 's1', 1, 1, 0, 'threshold', 'search', '4h')",
    ).run();
    const cron = await import(root + "/alerts/cron.ts");
    const store = await import(root + "/alerts/monitor-store.ts");
    ${body}
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", script], {
    env: {
      ...process.env,
      NODE_PATH: join(root, "../node_modules"),
      SQLITE_PATH: ":memory:",
      CLICKHOUSE_URL: "http://clickhouse.test",
      TOPOSCOPE_WATCHDOG_URL: "",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (child.exitCode !== 0) {
    throw new Error(child.stderr.toString());
  }
  const lines = child.stdout.toString().trim().split("\n");
  return JSON.parse(lines[lines.length - 1]!);
}

describe("the monitor loop (#175, found reviewing #184)", () => {
  test("a pass longer than the interval does not overlap the next, so the open call goes once", () => {
    // Reads take 150ms and the webhook 200ms; the loop ticks every 40ms.
    const out = runLoop(
      `
      state.chMs = 150;
      state.hookMs = 200;
      cron.startAlertCron();
      await sleep(1500);
      console.log(JSON.stringify({ opens: state.calls.filter((c) => c.state === "open").length, state: db.query("SELECT state FROM alert_rules").get().state }));
      process.exit(0);
      `,
      { ALERT_CRON_MS: "40" },
    );
    expect(out.state).toBe("open");
    expect(out.opens).toBe(1);
  });

  test("a monitor whose saved search was deleted closes its open stretch like an edit, without a call", () => {
    const out = runLoop(`
      await cron.evaluateAlerts(Date.parse("2026-10-20T10:41:00.000Z"));
      const opened = db.query("SELECT state FROM alert_rules").get().state;
      db.query("DELETE FROM saved_searches WHERE id = 's1'").run();
      const before = state.calls.length;
      await cron.evaluateAlerts(Date.parse("2026-10-20T10:42:00.000Z"));
      const [stretch] = store.monitorHistory("m1", 200, db);
      console.log(JSON.stringify({ opened, state: db.query("SELECT state FROM alert_rules").get().state, stretch, calls: state.calls.length - before }));
    `);
    expect(out.opened).toBe("open");
    expect(out.state).toBe("ok");
    expect(out.stretch).toMatchObject({ resolved_at: Date.parse("2026-10-20T10:42:00.000Z"), closed_by: "edit", resolved_call: "none" });
    expect(out.calls).toBe(0);
  });

  test("so does one whose saved search became a board, which a monitor cannot read", () => {
    const out = runLoop(`
      await cron.evaluateAlerts(Date.parse("2026-10-20T10:41:00.000Z"));
      db.query("UPDATE saved_searches SET board = ? WHERE id = 's1'").run(JSON.stringify({ keys: ["service"], win: false }));
      await cron.evaluateAlerts(Date.parse("2026-10-20T10:42:00.000Z"));
      const [stretch] = store.monitorHistory("m1", 200, db);
      console.log(JSON.stringify({ state: db.query("SELECT state FROM alert_rules").get().state, stretch, calls: state.calls.map((c) => c.state) }));
    `);
    expect(out.state).toBe("ok");
    expect(out.stretch).toMatchObject({ closed_by: "edit", resolved_call: "none" });
    expect(out.calls).toEqual(["open"]);
  });
});

describe("who watches Toposcope: TOPOSCOPE_WATCHDOG_URL (#179)", () => {
  test("each pass checks in; with ClickHouse down it checks in at /fail; unset, nothing is called", () => {
    const out = runLoop(
      `
      cron.startAlertCron();
      await sleep(330);
      const up = state.calls.filter((c) => c.url.startsWith("http://watchdog.test")).map((c) => c.method + " " + c.url);
      state.chDown = true;
      const from = state.calls.length;
      await sleep(220);
      const down = state.calls.slice(from).filter((c) => c.url.startsWith("http://watchdog.test")).map((c) => c.url);
      console.log(JSON.stringify({ up, down }));
      process.exit(0);
      `,
      { ALERT_CRON_MS: "50", TOPOSCOPE_WATCHDOG_URL: "http://watchdog.test/ping/9f2c?rid=a" },
    );
    expect(out.up.length).toBeGreaterThanOrEqual(3);
    expect(new Set(out.up)).toEqual(new Set(["GET http://watchdog.test/ping/9f2c?rid=a"]));
    // Within two passes of ClickHouse stopping.
    expect(out.down.length).toBeGreaterThanOrEqual(1);
    expect(out.down.slice(0, 2)).toContain("http://watchdog.test/ping/9f2c/fail?rid=a");
    expect(out.down.at(-1)).toBe("http://watchdog.test/ping/9f2c/fail?rid=a");

    const unset = runLoop(
      `
      cron.startAlertCron();
      await sleep(250);
      console.log(JSON.stringify({ watchdog: state.calls.filter((c) => c.url.startsWith("http://watchdog.test")).length, reads: state.reads }));
      process.exit(0);
      `,
      { ALERT_CRON_MS: "50" },
    );
    expect(unset.reads).toBeGreaterThan(0);
    expect(unset.watchdog).toBe(0);
  });

  test("a stuck pass checks in nowhere, so the outside service notices", () => {
    const out = runLoop(
      `
      state.chMs = 10_000;
      cron.startAlertCron();
      await sleep(400);
      console.log(JSON.stringify({ watchdog: state.calls.filter((c) => c.url.startsWith("http://watchdog.test")).length, reads: state.reads }));
      process.exit(0);
      `,
      { ALERT_CRON_MS: "50", TOPOSCOPE_WATCHDOG_URL: "http://watchdog.test/hc" },
    );
    expect(out.reads).toBe(1);
    expect(out.watchdog).toBe(0);
  });
});

describe("a tick of the monitor loop (#179)", () => {
  const original = { ...monitorLoop };
  afterEach(() => {
    Object.assign(monitorLoop, original);
  });

  test("ok when the pass read its stores, fail when the pass threw or ClickHouse does not answer", async () => {
    const checkIns: boolean[] = [];
    monitorLoop.checkIn = async (ok) => {
      checkIns.push(ok);
      return null;
    };
    monitorLoop.evaluate = async () => {};
    monitorLoop.storesAnswer = async () => true;
    expect(await monitorTick()).toBe("ok");
    monitorLoop.storesAnswer = async () => false;
    expect(await monitorTick()).toBe("fail");
    monitorLoop.storesAnswer = async () => true;
    monitorLoop.evaluate = async () => {
      throw new Error("SQLITE_CANTOPEN");
    };
    expect(await monitorTick()).toBe("fail");
    expect(checkIns).toEqual([true, false, false]);
  });

  test("a tick while the last pass runs is skipped and checks in nowhere", async () => {
    let release = () => {};
    let passes = 0;
    const checkIns: boolean[] = [];
    monitorLoop.evaluate = () => {
      passes++;
      return new Promise<void>((ok) => {
        release = ok;
      });
    };
    monitorLoop.storesAnswer = async () => true;
    monitorLoop.checkIn = async (ok) => {
      checkIns.push(ok);
      return null;
    };
    const first = monitorTick();
    expect(await monitorTick()).toBe("skipped");
    expect(await monitorTick()).toBe("skipped");
    release();
    expect(await first).toBe("ok");
    expect(passes).toBe(1);
    expect(checkIns).toEqual([true]);
    monitorLoop.evaluate = async () => {
      passes++;
    };
    expect(await monitorTick()).toBe("ok");
    expect(passes).toBe(2);
  });
});

describe("the watchdog address (#179)", () => {
  test("an http or https address; unset is none; anything else stops the app at boot with a reason", () => {
    expect(watchdogUrl({})).toBeNull();
    expect(watchdogUrl({ TOPOSCOPE_WATCHDOG_URL: "  " })).toBeNull();
    expect(watchdogUrl({ TOPOSCOPE_WATCHDOG_URL: "https://hc-ping.com/5a1b2c3d-0000-4000-8000-000000000000" })).toBe(
      "https://hc-ping.com/5a1b2c3d-0000-4000-8000-000000000000",
    );
    expect(watchdogUrl({ TOPOSCOPE_WATCHDOG_URL: "http://kuma.lan:3001/api/push/abc?status=up&msg=OK" })).toBe(
      "http://kuma.lan:3001/api/push/abc?status=up&msg=OK",
    );
    expect(watchdogUrlError({})).toBeNull();
    for (const bad of ["hc-ping.com/abc", "ftp://hc-ping.com/abc", "https://hc-ping.com/abc#x"]) {
      expect(watchdogUrl({ TOPOSCOPE_WATCHDOG_URL: bad })).toBeNull();
      expect(watchdogUrlError({ TOPOSCOPE_WATCHDOG_URL: bad })).toBe(
        "TOPOSCOPE_WATCHDOG_URL must be an http or https address to check in at, with no #fragment",
      );
    }
  });

  test("/fail goes on the path, as Healthchecks and Better Stack read it; a query stays", () => {
    expect(watchdogFailUrl("https://hc-ping.com/abc")).toBe("https://hc-ping.com/abc/fail");
    expect(watchdogFailUrl("https://hc-ping.com/abc/")).toBe("https://hc-ping.com/abc/fail");
    expect(watchdogFailUrl("https://uptime.betterstack.com/api/v1/heartbeat/tok")).toBe(
      "https://uptime.betterstack.com/api/v1/heartbeat/tok/fail",
    );
    expect(watchdogFailUrl("https://logs.example.com/ping/9f2c?rid=1")).toBe("https://logs.example.com/ping/9f2c/fail?rid=1");
  });

  test("a check-in is a GET; one that does not go through is told, never thrown", async () => {
    const sent: string[] = [];
    const send = (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push(`${init?.method} ${String(url)}`);
      return new Response("OK", { status: 200 });
    }) as typeof fetch;
    expect(await pingWatchdog(true, "https://hc-ping.com/abc", send)).toEqual({ status: "200" });
    expect(await pingWatchdog(false, "https://hc-ping.com/abc", send)).toEqual({ status: "200" });
    expect(await pingWatchdog(true, null, send)).toBeNull();
    expect(sent).toEqual(["GET https://hc-ping.com/abc", "GET https://hc-ping.com/abc/fail"]);
    const down = (async () => {
      throw Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" });
    }) as unknown as typeof fetch;
    expect(await pingWatchdog(true, "https://hc-ping.com/abc", down)).toEqual({ status: "error" });
    const gone = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    expect(await pingWatchdog(true, "https://hc-ping.com/abc", gone)).toEqual({ status: "404" });
  });
});
