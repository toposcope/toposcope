import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = import.meta.dir;
const fixture = mkdtempSync(join(tmpdir(), "toposcope-fewer-than-"));
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
    // ClickHouse answers no counts, and one line from the box to a newest-first page.
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith("/ping")) return new Response("Ok.");
      if (String(url).startsWith("http://clickhouse.test")) {
        const sql = String(init?.body ?? "");
        if (/ORDER BY ts DESC/.test(sql) && /LIMIT/.test(sql)) {
          return Response.json({ data: [{ ts: "2026-10-20 10:26:41.208", service: "ci-runner", host: "ci-box", level: "info", message: "runner ci-03 picked job 88412", attrs: "{}", seq: "1", toposcope: "" }] });
        }
        return Response.json({ data: [] });
      }
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
      // Every monitor names its service (#335): a fixture that does not name one is about "api".
      if (body && typeof body === "object" && !("service" in body) && (method === "PUT" || method === "POST") && (path.startsWith("/api/monitors/") || path.startsWith("/api/alert-rules"))) body = { service: "api", ...body };
      // #360: a token previews a monitor before it saves it, as an agent does.
      await (await import(root + "/design/preview-for-scripts.ts")).previewMonitorFirst((req) => app.fetch(req), "http://app.test" + path, { method, headers: auth, body });
      const res = await app.fetch(new Request("http://app.test" + path, { method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body) }));
      const text = await res.text();
      out[key] = { status: res.status, body: text.startsWith("{") ? JSON.parse(text) : text };
      return out[key];
    };
    const hook = "https://ntfy.example.com/agental-ops";
    const lines = (await go("saved", "/api/saved-searches", "POST", { name: "ci-box lines", query: "host:ci-box", range: "15m" })).body;
    const slow = (await go("savedP99", "/api/saved-searches", "POST", { name: "api p99", query: "service:api", range: "15m", agg: "p99:duration_ms" })).body;
    const rate = (await go("savedRate", "/api/saved-searches", "POST", { name: "api rate", query: "service:api", range: "15m", agg: "rate" })).body;
    const fixed = (await go("savedFixed", "/api/saved-searches", "POST", { name: "that hour", query: "host:ci-box", from: "2026-10-20T09:00:00.000Z", to: "2026-10-20T10:00:00.000Z" })).body;
    await go("quiet", "/api/monitors/ci-box%20went%20quiet", "PUT", { source: "search", saved_search_id: lines.id, opens_when: "fewer_than", threshold: 1, webhook_url: hook });
    await go("p99", "/api/monitors/p99%20quiet", "PUT", { source: "search", saved_search_id: slow.id, opens_when: "fewer_than", threshold: 100, webhook_url: hook });
    await go("rate", "/api/monitors/rate%20quiet", "PUT", { source: "search", saved_search_id: rate.id, opens_when: "fewer_than", threshold: 0.5, webhook_url: hook });
    await go("fixed", "/api/monitors/fixed%20quiet", "PUT", { source: "search", saved_search_id: fixed.id, opens_when: "fewer_than", threshold: 1, webhook_url: hook });
    await go("zero", "/api/monitors/zero", "PUT", { source: "search", saved_search_id: lines.id, opens_when: "fewer_than", threshold: 0, webhook_url: hook });
    await go("loud", "/api/alert-rules", "POST", { name: "ci-box loud", saved_search_id: lines.id, threshold: 50, webhook_url: hook });
    await go("flip", "/api/alert-rules/" + out.loud.body.id, "PUT", { opens_when: "fewer_than", threshold: 1 });
    await go("p99Edit", "/api/alert-rules/" + out.loud.body.id, "PUT", { saved_search_id: slow.id });
    await go("monitors", "/api/monitors");
    await go("one", "/api/monitors/ci-box%20went%20quiet");
    await go("probe", "/api/saved-searches/" + lines.id + "/test", "POST");
    await go("testCall", "/api/alert-rules/test-call", "POST", { name: "x", saved_search_id: slow.id, opens_when: "fewer_than", threshold: 1, webhook_url: hook });
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

describe("a monitor on a saved search reads at least or fewer than (#176)", () => {
  test("PUT declares a fewer-than monitor; fewer than 1 is legal", () => {
    expect(r.quiet!.status).toBe(201);
    expect(r.quiet!.body).toMatchObject({ name: "ci-box went quiet", opens_when: "fewer_than", threshold: 1, state: "ok" });
    expect(r.rate!.status).toBe(201);
    expect(r.rate!.body.opens_when).toBe("fewer_than");
  });

  test("p99(duration_ms) fewer than 100 is refused with a reason", () => {
    expect(r.p99!.status).toBe(400);
    expect(r.p99!.body.error).toBe("fewer than reads a count or a rate; p99(duration_ms) over no lines has no value");
    expect(r.p99Edit!.status).toBe(400);
  });

  test("a fixed from/to is refused for fewer than", () => {
    expect(r.fixed!.status).toBe(400);
    expect(r.fixed!.body.error).toBe("fewer than needs a relative window (range=15m), not a fixed from/to");
  });

  test("fewer than 0 can never open, and is refused as any threshold of 0 is", () => {
    expect(r.zero!.status).toBe(400);
    expect(r.zero!.body.error).toBe("threshold must be > 0");
  });

  test("a monitor made at least stays at least, and an edit turns it", () => {
    expect(r.loud!.body.opens_when).toBe("at_least");
    expect(r.flip!.status).toBe(200);
    expect(r.flip!.body).toMatchObject({ opens_when: "fewer_than", threshold: 1 });
  });

  test("Watch carries a quiet monitor's last line; a loud one reads none", () => {
    const listed = r.monitors!.body.monitors as Array<{ name: string; last_line_at?: number | null }>;
    expect(listed.find((m) => m.name === "ci-box went quiet")?.last_line_at).toBe(Date.parse("2026-10-20T10:26:41.208Z"));
    expect(r.one!.body.last_line_at).toBe(Date.parse("2026-10-20T10:26:41.208Z"));
    expect(listed.find((m) => m.name === "rate quiet")).toHaveProperty("last_line_at");
  });

  test("the editor's reading says the last line, and that it can't tell in Toposcope's first window", () => {
    expect(r.probe!.status).toBe(200);
    expect(r.probe!.body).toMatchObject({ count: 0, refused: false, last_line_at: Date.parse("2026-10-20T10:26:41.208Z") });
    expect(r.probe!.body.cant_tell).toMatchObject({ kind: "starting" });
  });

  test("a test call for p99 fewer than is refused with the same reason", () => {
    expect(r.testCall!.status).toBe(400);
    expect(r.testCall!.body.error).toContain("fewer than reads a count or a rate");
  });
});
