import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = import.meta.dir;
const fixture = mkdtempSync(join(tmpdir(), "toposcope-api-regression-"));
type Result = {
  status: number;
  contentType: string | null;
  body: unknown;
  stored?: number;
  commands?: string[];
};
let results: Record<string, Result>;

beforeAll(async () => {
  await Bun.write(join(fixture, "src/ui/dist/index.html"), "<!doctype html><html>test UI</html>");
  // Boot services are stubbed in a child process so module mocks cannot affect
  // the other tests. HTTP routing, auth, SQLite, and retention SQL are real.
  const script = `
    import { mock } from "bun:test";
    const root = ${JSON.stringify(root)};
    const migrate = await import(root + "/shared/migrate.ts");
    mock.module(root + "/shared/migrate.ts", () => ({
      ...migrate, migrateStore: async () => {}, syncFieldRoleSkip: async () => {}
    }));
    mock.module(root + "/alerts/cron.ts", () => ({ startAlertCron() {} }));
    mock.module(root + "/ingest/syslog.ts", () => ({ startSyslogUdp: async () => {} }));
    const commands = [];
    globalThis.fetch = async (url, init) => {
      if (!String(url).startsWith("http://clickhouse.test")) throw new Error("Unexpected external fetch");
      if (String(url).endsWith("/ping")) return new Response("Ok.");
      const sql = String(init?.body ?? "");
      commands.push(sql);
      if (sql.startsWith("SELECT name")) return Response.json({ data: migrate.retentionTtlTables.map(({table}) => ({ name: table, engine_full: "TTL toDate(ts) + toIntervalDay(30)" })) });
      return new Response("");
    };
    const app = (await import(root + "/index.ts")).default;
    for (let i = 0; i < 50; i++) {
      const health = await app.fetch(new Request("http://app.test/api/health"));
      if (health.status === 200) break;
      if (i === 49) throw new Error("Isolated app did not become ready");
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const settings = await import(root + "/control/settings.ts");
    const headers = { authorization: "Basic " + btoa("operator:regression-only"), "content-type": "application/json" };
    const out = {};
    for (const value of ["0", "-1", "0.5", "10.5", "366", "1e400", "-1e400"]) {
      settings.writeRetentionDays(30);
      commands.length = 0;
      const response = await app.fetch(new Request("http://app.test/api/settings", { method: "PUT", headers, body: '{"retention_days":' + value + '}' }));
      out[value] = { status: response.status, contentType: response.headers.get("content-type"), body: await response.json(), stored: settings.getRetentionDays(), commands: [...commands] };
    }
    for (const days of [1, 365]) {
      commands.length = 0;
      const response = await app.fetch(new Request("http://app.test/api/settings", { method: "PUT", headers, body: JSON.stringify({ retention_days: days }) }));
      out["valid-" + days] = { status: response.status, contentType: response.headers.get("content-type"), body: await response.json(), stored: settings.getRetentionDays(), commands: [...commands] };
    }
    for (const [name, path, requestHeaders, method] of [
      ["unauthorized", "/api/no-such-endpoint", {}, "GET"],
      ["known", "/api/settings", headers, "GET"],
      ["post", "/api/no-such-endpoint", headers, "POST"],
      ["spa", "/workspace/reader", headers, "GET"],
    ]) {
      const response = await app.fetch(new Request("http://app.test" + path, { headers: requestHeaders, method }));
      const text = await response.text();
      out[name] = { status: response.status, contentType: response.headers.get("content-type"), body: text.startsWith("{") ? JSON.parse(text) : text };
    }
    for (const name of ["built", "unbuilt"]) {
      if (name === "unbuilt") (await import("node:fs")).unlinkSync("src/ui/dist/index.html");
      const response = await app.fetch(new Request("http://app.test/api/no-such-endpoint", { headers }));
      const text = await response.text();
      out[name] = { status: response.status, contentType: response.headers.get("content-type"), body: text.startsWith("{") ? JSON.parse(text) : text };
    }
    console.log(JSON.stringify(out));
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", script], {
    cwd: fixture,
    env: {
      ...process.env,
      NODE_PATH: join(root, "../node_modules"),
      TOPOSCOPE_DEV: "1",
      TOPOSCOPE_PASSWORD: "regression-only",
      SQLITE_PATH: ":memory:",
      CLICKHOUSE_URL: "http://clickhouse.test",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  results = JSON.parse(child.stdout.toString());
});

afterAll(() => rmSync(fixture, { recursive: true, force: true }));

describe("retention HTTP validation", () => {
  test.each(["0", "-1", "0.5", "10.5", "366", "1e400", "-1e400"])(
    "rejects %s before changing SQLite or ClickHouse TTL",
    (value) => {
      const result = results[value]!;
      expect(result.status).toBe(400);
      expect(result.stored).toBe(30);
      expect(result.commands).toEqual([]);
    },
  );
  test.each([1, 365])("accepts valid boundary %s and applies TTL", (days) => {
    const result = results[`valid-${days}`]!;
    expect(result.status).toBe(200);
    expect(result.stored).toBe(days);
    expect(result.body).toEqual({ retention_days: days });
    expect(result.commands?.filter((sql) => sql.startsWith("ALTER TABLE"))).toHaveLength(10);
    expect(result.commands?.find((sql) => sql.startsWith("ALTER TABLE logs "))).toContain(`INTERVAL ${days} DAY`);
  });
});

describe("API not found", () => {
  test.each(["built", "unbuilt"])("unknown GET returns JSON 404 with %s UI", (state) => {
    expect(results[state]!.status).toBe(404);
    expect(results[state]!.contentType).toContain("application/json");
    expect(results[state]!.body).toEqual({ error: "Not found" });
  });
  test("unknown API still requires operator authentication", () => {
    expect(results.unauthorized!.status).toBe(401);
  });
  test("known API still returns its JSON result", () => {
    expect(results.known!.status).toBe(200);
    expect(results.known!.body).toEqual({ retention_days: 365 });
  });
  test("unknown POST returns the same JSON 404", () => {
    expect(results.post!.status).toBe(404);
    expect(results.post!.body).toEqual({ error: "Not found" });
  });
  test("non-API workspace paths retain the UI fallback", () => {
    expect(results.spa!.status).toBe(200);
    expect(results.spa!.contentType).toContain("text/html");
  });
});
