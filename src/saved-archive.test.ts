import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateControlDb } from "./control/index";

/** Sheet 50: a saved hunt or board is archived off Home and search; its link opens and its monitor runs. */

describe("the archived column", () => {
  test("a store from before sheet 50 gains it, every row not archived; a second boot leaves it", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE saved_searches (id TEXT PRIMARY KEY, name TEXT NOT NULL, query TEXT NOT NULL, created_at INTEGER NOT NULL)");
    db.query("INSERT INTO saved_searches (id, name, query, created_at) VALUES ('h1', 'A hunt', 'service:api', 1)").run();
    migrateControlDb(db);
    const col = (db.query("PRAGMA table_info(saved_searches)").all() as Array<{ name: string; notnull: number; dflt_value: string | null }>).find((c) => c.name === "archived");
    expect(col).toMatchObject({ notnull: 1, dflt_value: "0" });
    expect(db.query("SELECT archived FROM saved_searches WHERE id = 'h1'").get()).toEqual({ archived: 0 });
    db.query("UPDATE saved_searches SET archived = 1 WHERE id = 'h1'").run();
    migrateControlDb(db);
    expect(db.query("SELECT archived FROM saved_searches WHERE id = 'h1'").get()).toEqual({ archived: 1 });
  });
});

const root = import.meta.dir;
const fixture = mkdtempSync(join(tmpdir(), "toposcope-archive-"));
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
    mock.module(root + "/alerts/http-cron.ts", () => ({ startHttpMonitors() {} }));
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
    const auth = { authorization: (await import(root + "/control/owner-for-tests.ts")).ownerBearer(), "content-type": "application/json" };
    const go = async (key, path, method = "GET", body) => {
      if (method !== "GET" && path.startsWith("/api/alert-rules")) {
        await (await import(root + "/design/preview-for-scripts.ts")).previewMonitorFirst((req) => app.fetch(req), "http://app.test" + path, { method, headers: auth, body });
      }
      const res = await app.fetch(new Request("http://app.test" + path, { method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body) }));
      const text = await res.text();
      out[key] = { status: res.status, body: text.startsWith("{") ? JSON.parse(text) : text };
      return out[key];
    };
    const hunt = (await go("made", "/api/saved-searches", "POST", { name: "Nightly job silent", query: "service:fleet", range: "15m" })).body;
    await go("other", "/api/saved-searches", "POST", { name: "API errors", query: "service:api level:error", range: "15m" });
    await go("monitor", "/api/alert-rules", "POST", { name: "Nightly job silent", service: "fleet", saved_search_id: hunt.id, threshold: 1, webhook_url: "https://hooks.example.com/page" });
    await go("homeBefore", "/api/home/since?since=hour");
    await go("archive", "/api/saved-searches/" + hunt.id, "PUT", { archived: true });
    await go("list", "/api/saved-searches");
    await go("homeAfter", "/api/home/since?since=hour");
    await go("rules", "/api/alert-rules");
    await go("run", "/api/saved-searches/" + hunt.id + "/run");
    await go("rename", "/api/saved-searches/" + hunt.id, "PUT", { name: "Nightly job silent (old)" });
    await go("bad", "/api/saved-searches/" + hunt.id, "PUT", { archived: "yes" });
    await go("unarchive", "/api/saved-searches/" + hunt.id, "PUT", { archived: false });
    console.log(JSON.stringify(out));
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", script], {
    cwd: fixture,
    env: { ...process.env, NODE_PATH: join(root, "../node_modules"), TOPOSCOPE_DEV: "1", TOPOSCOPE_PASSWORD: "pw", TOPOSCOPE_INGEST_TOKEN: "ingest-only", SQLITE_PATH: ":memory:", CLICKHOUSE_URL: "http://clickhouse.test", OTLP_GRPC_PORT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  r = JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!);
});

afterAll(() => rmSync(fixture, { recursive: true, force: true }));

describe("PUT /api/saved-searches/:id with archived", () => {
  test("a new hunt is not archived; archiving one says so in the list", () => {
    expect(r.made!.body.archived).toBe(false);
    expect(r.archive!.status).toBe(200);
    expect(r.archive!.body.archived).toBe(true);
    const byName = Object.fromEntries((r.list!.body.searches as Array<{ name: string; archived: boolean }>).map((s) => [s.name, s.archived]));
    expect(byName).toEqual({ "Nightly job silent": true, "API errors": false });
  });

  test("Home does not read an archived hunt", () => {
    const names = (k: string) => (r[k]!.body.cards as Array<{ name: string }>).map((c) => c.name).sort();
    expect(names("homeBefore")).toEqual(["API errors", "Nightly job silent"]);
    expect(names("homeAfter")).toEqual(["API errors"]);
  });

  test("its monitor stays, and the hunt still opens and runs by its id", () => {
    expect(r.monitor!.status).toBe(201);
    const rules = (r.rules!.body.rules ?? r.rules!.body) as Array<{ name: string; enabled: number | boolean }>;
    expect(Boolean(rules.find((x) => x.name === "Nightly job silent")?.enabled)).toBe(true);
    expect(r.run!.status).toBe(200);
  });

  test("another edit keeps it archived; archived is true or false; it comes back", () => {
    expect(r.rename!.body.archived).toBe(true);
    expect(r.bad!.status).toBe(400);
    expect(r.unarchive!.body.archived).toBe(false);
  });
});
