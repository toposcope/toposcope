import { describe, expect, test } from "bun:test";
import { join } from "node:path";

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
