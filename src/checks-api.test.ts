import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Push monitors (#177) through the app as it runs: `POST /v1/checks` with the ingest token, the
// keyed `/ping/<key>` URL with none, `/v1/probes` read as a result, and where the key is shown.

const root = import.meta.dir;
const fixture = mkdtempSync(join(tmpdir(), "toposcope-checks-"));
type R = { status: number; body: any; text: string };
let r: Record<string, R>;
let rows: Record<string, Array<Record<string, any>>>;

beforeAll(async () => {
  await Bun.write(join(fixture, "src/ui/dist/index.html"), "<!doctype html><html>the app</html>");
  const script = `
    import { mock } from "bun:test";
    const root = ${JSON.stringify(root)};
    const migrate = await import(root + "/shared/migrate.ts");
    mock.module(root + "/shared/migrate.ts", () => ({ ...migrate, migrateStore: async () => {}, syncFieldRoleSkip: async () => {} }));
    mock.module(root + "/alerts/cron.ts", () => ({ startAlertCron() {} }));
    mock.module(root + "/ingest/syslog.ts", () => ({ startSyslogUdp: async () => {} }));
    const inserted = {};
    globalThis.fetch = async (url, init) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith("/ping")) return new Response("Ok.");
      if (u.origin === "http://clickhouse.test") {
        const table = (u.searchParams.get("query") ?? "").match(/^INSERT INTO (\\w+) /)?.[1];
        if (table) {
          (inserted[table] ??= []).push(...String(init?.body ?? "").split("\\n").filter(Boolean).map((l) => JSON.parse(l)));
          return new Response("");
        }
        // A monitor's results are read back from ClickHouse (#324): the latest first.
        const sql = String(init?.body ?? "");
        if (sql.includes("FROM monitor_results")) {
          const id = u.searchParams.get("param_id");
          const rows = (inserted.monitor_results ?? [])
            .filter((row) => !id || row.monitor_id === id)
            .sort((a, b) => b.seq - a.seq)
            .map(({ at, seq, ...row }) => ({ ...row, id: seq, at_ms: Date.parse(at.replace(" ", "T") + "Z") }));
          return Response.json({ data: rows });
        }
        return Response.json({ data: [] });
      }
      throw new Error("Unexpected external fetch " + url);
    };
    const app = (await import(root + "/index.ts")).default;
    for (let i = 0; i < 50; i++) {
      if ((await app.fetch(new Request("http://app.test/api/health"))).status === 200) break;
      await new Promise((ok) => setTimeout(ok, 0));
    }
    const out = {};
    const basic = { authorization: (await import(root + "/control/owner-for-tests.ts")).ownerBearer(), "content-type": "application/json" };
    const bearer = { authorization: "Bearer ingest-only", "content-type": "application/json" };
    const go = async (key, path, method = "GET", body, headers = basic) => {
      // Every monitor names its service (#335): a fixture that does not name one is about "api".
      if (body && typeof body === "object" && !("service" in body) && (method === "PUT" || method === "POST") && (path.startsWith("/api/monitors/") || path.startsWith("/api/alert-rules"))) body = { service: "api", ...body };
      const res = await app.fetch(new Request("http://app.test" + path, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) }));
      const text = await res.text();
      out[key] = { status: res.status, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text, text };
      return out[key];
    };
    const logCount = () => (inserted.logs ?? []).length;
    // What each new monitor's row held when it was written (#335): its service, not filled in after.
    const controlDb = (await import(root + "/control/index.ts")).getDb();
    controlDb.run("CREATE TEMP TABLE first_writes (name TEXT, service TEXT)");
    controlDb.run("CREATE TEMP TRIGGER first_write AFTER INSERT ON main.alert_rules BEGIN INSERT INTO first_writes VALUES (NEW.name, NEW.service); END");

    await go("first", "/v1/checks", "POST", { monitor: "disk-var", status: "warn", message: "/var 87% used", value: 87.2, unit: "%", every: "5m", grace: "2m", host: "log-vm", service: "box-agent", ts: "2026-10-20T11:03:00Z" }, bearer);
    await go("noToken", "/v1/checks", "POST", { monitor: "x", status: "ok" }, { "content-type": "application/json" });
    await go("nagios", "/v1/checks", "POST", [{ monitor: "check-disk", status: 2, message: "DISK CRITICAL" }, { monitor: "check-load", status: 3 }], bearer);
    await go("nagiosUnknown", "/v1/checks", "POST", { monitor: "check-disk", status: "3" }, bearer);
    await go("badStatus", "/v1/checks", "POST", [{ monitor: "a", status: "ok" }, { monitor: "b", status: "critical" }], bearer);
    await go("badEvery", "/v1/checks", "POST", { monitor: "a", status: "ok", every: "10s" }, bearer);
    await go("tooMany", "/v1/checks", "POST", Array.from({ length: 501 }, (_, i) => ({ monitor: "m" + i, status: "ok" })), bearer);
    const beforeCap = logCount();
    await go("overCap", "/v1/checks", "POST", Array.from({ length: 500 }, (_, i) => ({ monitor: "m" + i, status: "ok" })), bearer);
    out.overCapWrote = { status: 0, body: logCount() - beforeCap, text: "" };

    await go("hook", "/api/saved-searches", "POST", { name: "api errors", query: "service:api level:error", range: "15m" });
    await go("searchMon", "/api/alert-rules", "POST", { name: "api errors", saved_search_id: out.hook.body.id, threshold: 5, webhook_url: "https://hooks.example.com/x" });
    await go("nameTaken", "/v1/checks", "POST", { monitor: "api errors", status: "ok" }, bearer);

    await go("declare", "/api/monitors/nightly-backup", "PUT", { source: "push", every: "1d", grace: "1h" });
    const key = out.declare.body.ping_key;
    await go("list", "/api/monitors");
    await go("rules", "/api/alert-rules");
    await go("one", "/api/monitors/nightly-backup");

    const beforeUnknown = logCount();
    await go("unknownKey", "/ping/" + crypto.randomUUID(), "GET", undefined, {});
    await go("unknownKeyFail", "/ping/" + crypto.randomUUID() + "/fail", "POST", "it broke", {});
    await go("notAKey", "/ping/not-a-key", "GET", undefined, {});
    await go("badSignal", "/ping/" + key + "/later", "GET", undefined, {});
    out.unknownWrote = { status: 0, body: logCount() - beforeUnknown, text: "" };

    await go("start", "/ping/" + key + "/start", "GET", undefined, {});
    await go("fail", "/ping/" + key + "/fail", "POST", "unable to create lock in backend", {});
    await go("again", "/ping/" + key + "/fail", "POST", "again", {});
    await go("afterFail", "/api/monitors/nightly-backup");
    await new Promise((ok) => setTimeout(ok, 1100));
    await go("exit0", "/ping/" + key + "/0", "POST", "x".repeat(20000), {});
    await go("afterOk", "/api/monitors/nightly-backup");
    await new Promise((ok) => setTimeout(ok, 1100));
    await go("exit1", "/ping/" + key + "/1", "GET", undefined, {});
    await go("afterExit1", "/api/monitors/nightly-backup");

    await go("probe", "/v1/probes", "POST", { service: "api", up: 0, check: "api_health" }, bearer);
    await go("probeMon", "/api/monitors/api_health");

    const mon = out.one.body;
    await go("pause", "/api/alert-rules/" + mon.id, "PUT", { enabled: false });
    await go("edit", "/api/alert-rules/" + mon.id, "PUT", { every: "12h" });
    await go("editBad", "/api/alert-rules/" + mon.id, "PUT", { every: "5s" });
    await go("toSearch", "/api/monitors/nightly-backup", "PUT", { source: "search", saved_search_id: out.hook.body.id, threshold: 1, webhook_url: "https://hooks.example.com/x" });
    await go("toPush", "/api/monitors/api%20errors", "PUT", { source: "push" });
    await go("rotate", "/api/monitors/nightly-backup", "PUT", { source: "push", key: crypto.randomUUID() });
    await go("oldKey", "/ping/" + key, "GET", undefined, {});

    await go("setDefault", "/api/settings", "PUT", { default_webhook_url: "https://ntfy.sh/agental-ops" });
    await go("getDefault", "/api/settings");
    await go("badDefault", "/api/settings", "PUT", { default_webhook_url: "ftp://x" });
    await go("clearDefault", "/api/settings", "PUT", { default_webhook_url: "" });
    out.key = { status: 0, body: key, text: key };
    out.firstWrites = { status: 0, body: controlDb.query("SELECT name, service FROM first_writes").all(), text: "" };
    console.log(JSON.stringify({ out, inserted }));
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", script], {
    cwd: fixture,
    env: {
      ...process.env,
      NODE_PATH: join(root, "../node_modules"),
      TOPOSCOPE_DEV: "1",
      TOPOSCOPE_PASSWORD: "pw",
      TOPOSCOPE_INGEST_TOKEN: "ingest-only",
      SQLITE_PATH: ":memory:",
      CLICKHOUSE_URL: "http://clickhouse.test",
      OTLP_GRPC_PORT: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  const parsed = JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!) as {
    out: Record<string, R>;
    inserted: Record<string, Array<Record<string, any>>>;
  };
  r = parsed.out;
  rows = parsed.inserted;
}, 30_000);

afterAll(() => rmSync(fixture, { recursive: true, force: true }));

const logsOf = (name: string) =>
  (rows.logs ?? []).filter((row) => JSON.parse(row.attrs as string).monitor === name);

describe("POST /v1/checks (#177)", () => {
  test("a result for an unknown name creates its monitor", () => {
    expect(r.first!.status).toBe(200);
    expect(r.first!.body).toEqual({ ingested: 1, created: ["disk-var"] });
    const mon = r.list!.body.monitors.find((m: { name: string }) => m.name === "disk-var");
    expect(mon).toMatchObject({
      source: "push",
      state: "ok",
      last_result: "warn",
      last_value: 87.2,
      every_ms: 5 * 60_000,
      grace_ms: 2 * 60_000,
      webhook_url: null,
      query: "monitor:disk-var",
    });
  });

  test("a monitor made by its first result has that result's service from its first write (#335)", () => {
    const first = (name: string) => r.firstWrites!.body.filter((row: { name: string }) => row.name === name);
    expect(first("disk-var")).toEqual([{ name: "disk-var", service: "box-agent" }]);
    expect(first("check-disk")).toEqual([{ name: "check-disk", service: "monitor" }]);
    // One declared over the API is written with the service withPlace read, too.
    expect(first("nightly-backup")).toEqual([{ name: "nightly-backup", service: "api" }]);
    expect(r.firstWrites!.body.every((row: { service: string }) => row.service !== "")).toBe(true);
  });

  test("every result is a log row: monitor, status, source:push, with its host and service", () => {
    const [row] = logsOf("disk-var");
    expect(row).toMatchObject({ service: "box-agent", host: "log-vm", level: "warn", message: "/var 87% used" });
    expect(row!.ts).toStartWith("2026-10-20 11:03:00");
    expect(JSON.parse(row!.attrs)).toEqual({ monitor: "disk-var", status: "warn", source: "push" });
  });

  test("a value is the metric monitor_value, labelled with its monitor", () => {
    const point = (rows.metrics ?? []).find((m) => m.name === "monitor_value");
    expect(point).toMatchObject({ value: 87.2 });
    expect(JSON.stringify(point)).toContain('"monitor":"disk-var"');
  });

  test("Nagios's 2 opens and 3 changes nothing; a numeric status is the row's exit code", () => {
    expect(r.nagios!.body).toEqual({ ingested: 2, created: ["check-disk", "check-load"] });
    const disk = r.list!.body.monitors.find((m: { name: string }) => m.name === "check-disk");
    const load = r.list!.body.monitors.find((m: { name: string }) => m.name === "check-load");
    expect(disk).toMatchObject({ state: "open", last_result: "fail" });
    expect(load).toMatchObject({ state: "ok", last_result: null });
    expect(r.nagiosUnknown!.status).toBe(200);
    expect(JSON.parse(logsOf("check-disk")[0]!.attrs)).toMatchObject({ status: "fail", exit_code: "2" });
    expect(logsOf("check-disk")[0]!.level).toBe("error");
    expect(JSON.parse(logsOf("check-disk")[1]!.attrs)).toMatchObject({ status: "unknown", exit_code: "3" });
  });

  test("needs the ingest token", () => {
    expect(r.noToken!.status).toBe(401);
  });

  test("says which result is wrong, and stores none of the batch", () => {
    expect(r.badStatus!.status).toBe(400);
    expect(r.badStatus!.body.error).toBe("result 1: status must be ok, warn or fail, or 0–3");
    expect(r.badEvery!.body.error).toBe("every must be a span from 30s to 365d, like 5m, 1h or 1d");
    expect(logsOf("a")).toEqual([]);
  });

  test("a batch of 501 is refused", () => {
    expect(r.tooMany!.status).toBe(400);
    expect(r.tooMany!.body.error).toBe("Batch too large (max 500)");
  });

  test("past 500 push monitors a new name is refused with the reason, and nothing is written", () => {
    expect(r.overCap!.status).toBe(400);
    expect(r.overCap!.body.error).toBe(
      "500 push monitors is the most there can be; delete one in Watch, or send to a monitor that exists",
    );
    expect(r.overCapWrote!.body).toBe(0);
  });

  test("a name a search monitor has is not a push monitor's", () => {
    expect(r.nameTaken!.status).toBe(400);
    expect(r.nameTaken!.body.error).toBe("api errors is a search monitor; results go to push monitors");
  });
});

describe("the keyed /ping/<key> URL (#177)", () => {
  test("an unknown key gets 404 and writes nothing, with no token asked for", () => {
    for (const k of ["unknownKey", "unknownKeyFail", "notAKey", "badSignal"]) {
      expect(r[k]!.status).toBe(404);
      expect(r[k]!.text).toBe("not found\n");
    }
    expect(r.unknownWrote!.body).toBe(0);
  });

  test("/fail opens, with its POST body as the message", () => {
    expect(r.fail!.status).toBe(200);
    expect(r.fail!.text).toBe("OK\n");
    expect(r.afterFail!.body).toMatchObject({ state: "open", last_result: "fail" });
    expect(r.afterFail!.body.open.open_message).toBe("unable to create lock in backend");
    const failRow = logsOf("nightly-backup").find((row) => row.message === "unable to create lock in backend");
    expect(failRow).toMatchObject({ level: "error", service: "monitor" });
    expect(JSON.parse(failRow!.attrs)).toMatchObject({ monitor: "nightly-backup", status: "fail", source: "push" });
  });

  test("its /start is a row, and the result's run is measured from it", () => {
    expect(r.start!.status).toBe(200);
    const start = logsOf("nightly-backup").find((row) => JSON.parse(row.attrs).signal === "start");
    expect(JSON.parse(start!.attrs)).toEqual({ monitor: "nightly-backup", signal: "start", source: "push" });
    const failRow = logsOf("nightly-backup").find((row) => row.message === "unable to create lock in backend");
    expect(Number(JSON.parse(failRow!.attrs).duration_ms)).toBeGreaterThanOrEqual(0);
  });

  test("a second result within a second gets 429 and writes nothing", () => {
    expect(r.again!.status).toBe(429);
    expect(logsOf("nightly-backup").some((row) => row.message === "again")).toBe(false);
  });

  test("/<exit code>: 0 resolves it, its body cut to 10 KB; anything else is a fail", () => {
    expect(r.exit0!.status).toBe(200);
    expect(r.afterOk!.body).toMatchObject({ state: "ok", last_result: "ok" });
    const ok = logsOf("nightly-backup").find((row) => JSON.parse(row.attrs).exit_code === "0");
    expect(ok!.message.length).toBe(10 * 1024);
    expect(r.afterExit1!.body).toMatchObject({ state: "open", last_result: "fail" });
    expect(r.afterExit1!.body.last).toMatchObject({ result: "fail", exit_code: 1, via: "ping" });
  });

  test("a new key replaces the old one, which then gets 404", () => {
    expect(r.rotate!.status).toBe(200);
    expect(r.rotate!.body.ping_key).not.toBe(r.key!.body);
    expect(r.oldKey!.status).toBe(404);
  });
});

describe("where a key is printed (#177)", () => {
  test("on its monitor's page, and nowhere else", () => {
    const key = r.key!.body as string;
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.declare!.status).toBe(201);
    expect(r.one!.body.ping_key).toBe(key);
    expect(r.list!.text).not.toContain(key);
    expect(r.rules!.text).not.toContain(key);
    expect(r.pause!.text).not.toContain(key);
    expect(JSON.stringify(rows)).not.toContain(key);
  });
});

describe("a push monitor declared or edited (#177)", () => {
  test("PUT /api/monitors/<name> with source push creates it with its schedule", () => {
    expect(r.declare!.body).toMatchObject({ name: "nightly-backup", source: "push", every_ms: 86_400_000, grace_ms: 3_600_000, state: "ok" });
  });

  test("an edit keeps what it leaves out; pausing says since when", () => {
    expect(r.pause!.body).toMatchObject({ enabled: 0, state: "ok" });
    expect(typeof r.pause!.body.paused_at).toBe("number");
    expect(r.edit!.body).toMatchObject({ every_ms: 12 * 3_600_000, grace_ms: 3_600_000, enabled: 0 });
    expect(r.editBad!.status).toBe(400);
  });

  test("a push monitor stays one, and a search monitor does not become one", () => {
    expect(r.toSearch!.status).toBe(400);
    expect(r.toSearch!.body.error).toBe("nightly-backup is a push monitor; delete it to make a search monitor of that name");
    expect(r.toPush!.body.error).toBe("api errors is a search monitor; delete it to make a push monitor of that name");
  });
});

describe("/v1/probes in attach mode is read as a result (#177)", () => {
  test("up 0 is a fail, and check names the monitor", () => {
    expect(r.probe!.status).toBe(200);
    expect(r.probe!.body).toEqual({ ingested: 1, up: 0 });
    expect(r.probeMon!.body).toMatchObject({ name: "api_health", source: "push", state: "open", last_result: "fail" });
    expect((rows.metrics ?? []).some((m) => m.name === "up")).toBe(true);
  });
});

describe("the default webhook in Settings (#177)", () => {
  test("is set, read back, refused when not http(s), and cleared", () => {
    expect(r.setDefault!.body.default_webhook_url).toBe("https://ntfy.sh/agental-ops");
    expect(r.getDefault!.body.default_webhook_url).toBe("https://ntfy.sh/agental-ops");
    expect(r.badDefault!.status).toBe(400);
    expect(r.clearDefault!.body.default_webhook_url).toBeNull();
  });
});
