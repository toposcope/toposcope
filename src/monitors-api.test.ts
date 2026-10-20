import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = import.meta.dir;
const fixture = mkdtempSync(join(tmpdir(), "toposcope-monitors-"));
type R = { status: number; body: any };
let r: Record<string, R>;

beforeAll(async () => {
  await Bun.write(join(fixture, "src/ui/dist/index.html"), "<!doctype html><html>the app</html>");
  const script = `
    import { mock } from "bun:test";
    const root = ${JSON.stringify(root)};
    const migrate = await import(root + "/shared/migrate.ts");
    mock.module(root + "/shared/migrate.ts", () => ({ ...migrate, migrateStore: async () => {}, syncFieldRoleSkip: async () => {} }));
    mock.module(root + "/alerts/cron.ts", () => ({ startAlertCron() {} }));
    mock.module(root + "/ingest/syslog.ts", () => ({ startSyslogUdp: async () => {} }));
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/ping")) return new Response("Ok.");
      if (String(url).startsWith("http://clickhouse.test")) return Response.json({ data: [] });
      throw new Error("Unexpected external fetch");
    };
    const app = (await import(root + "/index.ts")).default;
    for (let i = 0; i < 50; i++) {
      if ((await app.fetch(new Request("http://app.test/api/health"))).status === 200) break;
      await new Promise((ok) => setTimeout(ok, 0));
    }
    const out = {};
    const auth = { authorization: "Basic " + btoa("op:pw"), "content-type": "application/json" };
    const go = async (key, path, method = "GET", body) => {
      const res = await app.fetch(new Request("http://app.test" + path, { method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body) }));
      const text = await res.text();
      out[key] = { status: res.status, body: text.startsWith("{") ? JSON.parse(text) : text };
      return out[key];
    };
    const saved = (await go("saved", "/api/saved-searches", "POST", { name: "api errors search", query: "service:api level:error", range: "15m" })).body;
    const hook = "https://hooks.example.com/page";
    const made = (await go("create", "/api/alert-rules", "POST", { name: "api errors", saved_search_id: saved.id, threshold: 50, webhook_url: hook })).body;
    await go("list", "/api/alert-rules");
    await go("update", "/api/alert-rules/" + made.id, "PUT", { threshold: 60, remind_every: "1h" });
    await go("badRemind", "/api/alert-rules/" + made.id, "PUT", { remind_every: "2h" });
    await go("pause", "/api/alert-rules/" + made.id, "PUT", { enabled: false });
    await go("resume", "/api/alert-rules/" + made.id, "PUT", { enabled: true });
    await go("declare", "/api/monitors/ci-box%20went%20quiet", "PUT", { source: "search", saved_search: "api errors search", threshold: 1, webhook_url: hook });
    await go("redeclare", "/api/monitors/ci-box%20went%20quiet", "PUT", { source: "search", saved_search_id: saved.id, threshold: 3, webhook_url: hook, remind_every: "off" });
    await go("noSource", "/api/monitors/x", "PUT", { saved_search_id: saved.id, threshold: 1, webhook_url: hook });
    await go("noSearch", "/api/monitors/x", "PUT", { source: "search", saved_search: "no such search", threshold: 1, webhook_url: hook });
    await go("fpResolved", "/api/monitors/x", "PUT", { source: "fingerprints", saved_search_id: saved.id, threshold: 1, webhook_url: hook, body_kind: "text", body_template: "{{alert.name}}", resolved_body: "{{alert.name}} resolved" });
    await go("badResolved", "/api/monitors/x", "PUT", { source: "search", saved_search_id: saved.id, threshold: 1, webhook_url: hook, body_kind: "text", body_template: "{{alert.name}}", resolved_body: "{{mark.kind}} resolved" });
    await go("withResolved", "/api/monitors/ntfy", "PUT", { source: "search", saved_search_id: saved.id, threshold: 1, webhook_url: hook, body_kind: "text", body_template: "{{alert.name}} {{state}}", resolved_body: "{{alert.name}} resolved after {{duration}}" });
    await go("monitors", "/api/monitors");
    await go("monitors7d", "/api/monitors?range=7d");
    await go("monitorsHunt", "/api/monitors?from=2026-10-19T11:03:00.000Z&to=2026-10-20T11:03:00.000Z");
    await go("monitorsBad", "/api/monitors?range=1h");
    await go("one", "/api/monitors/ci-box%20went%20quiet");
    await go("dupA", "/api/alert-rules", "POST", { name: "twice", saved_search_id: saved.id, threshold: 1, webhook_url: hook });
    await go("dupB", "/api/alert-rules", "POST", { name: "twice", saved_search_id: saved.id, threshold: 1, webhook_url: hook });
    await go("dupPut", "/api/monitors/twice", "PUT", { source: "search", saved_search_id: saved.id, threshold: 1, webhook_url: hook });
    await go("delete", "/api/monitors/ci-box%20went%20quiet", "DELETE");
    await go("gone", "/api/monitors/ci-box%20went%20quiet");
    await go("deleteSearch", "/api/saved-searches/" + saved.id, "DELETE");
    console.log(JSON.stringify(out));
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", script], {
    cwd: fixture,
    env: { ...process.env, NODE_PATH: join(root, "../node_modules"), TOPOSCOPE_DEV: "1", TOPOSCOPE_PASSWORD: "pw", TOPOSCOPE_INGEST_TOKEN: "ingest-only", SQLITE_PATH: ":memory:", CLICKHOUSE_URL: "http://clickhouse.test", OTLP_GRPC_PORT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  r = JSON.parse(child.stdout.toString());
});

afterAll(() => rmSync(fixture, { recursive: true, force: true }));

describe("/api/alert-rules still answers as it did (#175)", () => {
  test("create answers 201 with the rule, which is now also a monitor", () => {
    expect(r.create!.status).toBe(201);
    expect(r.create!.body).toMatchObject({
      name: "api errors",
      kind: "threshold",
      threshold: 50,
      webhook_url: "https://hooks.example.com/page",
      enabled: 1,
      last_fired_at: null,
      last_attempt_at: null,
      consecutive_failures: 0,
      silenced_until: null,
      body_kind: "default",
      source: "search",
      state: "ok",
      remind_every: "4h",
    });
  });

  test("the list is { rules, link }", () => {
    expect(Object.keys(r.list!.body).sort()).toEqual(["link", "rules"]);
    expect(r.list!.body.rules.map((rule: { name: string }) => rule.name)).toEqual(["api errors"]);
  });

  test("an update keeps what it leaves out and takes remind_every", () => {
    expect(r.update!.status).toBe(200);
    expect(r.update!.body).toMatchObject({ threshold: 60, remind_every: "1h", name: "api errors" });
    expect(r.badRemind!.status).toBe(400);
    expect(r.badRemind!.body.error).toBe("remind_every must be off, window, 1h, 4h or 24h");
    expect(r.pause!.body.enabled).toBe(0);
    expect(r.resume!.body.enabled).toBe(1);
  });

  test("a saved search a monitor reads still cannot be deleted", () => {
    expect(r.deleteSearch!.status).toBe(409);
  });
});

describe("PUT /api/monitors/<name> (#175)", () => {
  test("creates a monitor of that name, then replaces it", () => {
    expect(r.declare!.status).toBe(201);
    expect(r.declare!.body).toMatchObject({ name: "ci-box went quiet", source: "search", threshold: 1, remind_every: "4h", state: "ok", open: null });
    expect(r.declare!.body.saved).toMatchObject({ name: "api errors search", query: "service:api level:error", range: "15m" });
    expect(r.redeclare!.status).toBe(200);
    expect(r.redeclare!.body.id).toBe(r.declare!.body.id);
    expect(r.redeclare!.body).toMatchObject({ threshold: 3, remind_every: "off" });
  });

  test("says what is wrong with a declaration", () => {
    expect(r.noSource!.status).toBe(400);
    expect(r.noSource!.body.error).toBe("source is required: search or fingerprints");
    expect(r.noSearch!.status).toBe(404);
    expect(r.fpResolved!.status).toBe(400);
    expect(r.fpResolved!.body.error).toBe("a new-fingerprints monitor does not resolve, so it has no resolved body");
    expect(r.badResolved!.status).toBe(400);
    expect(r.badResolved!.body.error).toBe("the resolved body: {{mark.kind}} is not a fill-in for this alert");
    expect(r.withResolved!.status).toBe(201);
    expect(r.withResolved!.body.resolved_body).toBe("{{alert.name}} resolved after {{duration}}");
  });

  test("two monitors of one name cannot be replaced by name", () => {
    expect(r.dupA!.status).toBe(201);
    expect(r.dupB!.status).toBe(201);
    expect(r.dupPut!.status).toBe(409);
  });

  test("is read and deleted by name", () => {
    expect(r.one!.status).toBe(200);
    expect(r.one!.body).toMatchObject({ name: "ci-box went quiet", stretches: [] });
    expect(r.delete!.status).toBe(200);
    expect(r.gone!.status).toBe(404);
  });
});

describe("GET /api/monitors (#175)", () => {
  test("lists every monitor with its state, and the window's stretches and calls", () => {
    expect(r.monitors!.status).toBe(200);
    const body = r.monitors!.body;
    expect(Object.keys(body).sort()).toEqual(["from", "link", "monitors", "now", "sent", "stretches", "to"]);
    expect(body.monitors.map((m: { name: string }) => m.name).sort()).toEqual(["api errors", "ci-box went quiet", "ntfy"]);
    expect(Date.parse(body.to) - Date.parse(body.from)).toBe(24 * 60 * 60_000);
    expect(Date.parse(r.monitors7d!.body.to) - Date.parse(r.monitors7d!.body.from)).toBe(7 * 24 * 60 * 60_000);
    expect(r.monitorsHunt!.body.from).toBe("2026-10-19T11:03:00.000Z");
    expect(r.monitorsBad!.status).toBe(400);
  });
});
