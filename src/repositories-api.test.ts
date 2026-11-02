import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = import.meta.dir;
const fixture = mkdtempSync(join(tmpdir(), "toposcope-repositories-"));
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
    // api names its repository on its resource; auth's newest deploy mark carries repo; billing and
    // checkout have neither. api deployed 1.4.1 then 1.4.2.
    const mark = (id, ts, version, sha, service = "api", attrs = {}) => ({ ts, end_ts: null, kind: "deploy", service, title: version, attrs: { version, sha, ...attrs }, id, toposcope: "" });
    const m142 = mark("deploy-api-1.4.2", "2026-11-02 14:02:00.000", "1.4.2", "4f9c1e7d");
    const m141 = mark("deploy-api-1.4.1", "2026-11-02 08:05:00.000", "1.4.1", "9e21aa03");
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith("/ping")) return new Response("Ok.");
      if (String(url).startsWith("http://clickhouse.test")) {
        const sql = String(init?.body ?? "");
        const p = new URL(String(url)).searchParams;
        const only = p.get("param_service");
        const one = (rows) => Response.json({ data: only ? rows.filter((x) => x.service === only) : rows });
        if (/FROM logs_attr_values_by_minute/.test(sql)) return one([{ service: "api", url: "https://github.com/acme/api" }]);
        if (/FROM spans|FROM logs\\s/.test(sql)) return one([]);
        if (/UNION DISTINCT/.test(sql)) return Response.json({ data: ["api", "auth", "billing", "checkout"].map((service) => ({ service })) });
        if (/argMax\\(attrs\\['repo'\\]/.test(sql)) return one([{ service: "auth", url: "git@github.com:acme/auth.git", id: "deploy-auth-2.3.0", version: "2.3.0", title: "auth 2.3.0" }]);
        if (/id = \\{id:String\\}/.test(sql)) return Response.json({ data: p.get("param_id") === m142.id ? [m142] : [] });
        if (/ts < parseDateTime64BestEffort/.test(sql)) return Response.json({ data: [m141] });
        if (/attrs\\['version'\\] = \\{version:String\\}/.test(sql)) return Response.json({ data: [m142, m141].filter((m) => m.attrs.version === p.get("param_version")) });
        return Response.json({ data: [] });
      }
      throw new Error("Unexpected external fetch");
    };
    const app = (await import(root + "/index.ts")).default;
    for (let i = 0; i < 50; i++) {
      if ((await app.fetch(new Request("http://app.test/api/health"))).status === 200) break;
      await new Promise((ok) => setTimeout(ok, 0));
    }
    const people = await import(root + "/control/people.ts");
    const bearer = (name, role) => {
      const account = people.createServiceAccount({ name, role, created_by: "tests" });
      return "Bearer " + people.createPersonToken(account.id, { name, created_by: "tests" }).token;
    };
    const tokens = { operator: bearer("ops-bot", "operator"), viewer: bearer("reader", "viewer") };
    const out = {};
    const go = async (key, path, method = "GET", body, as = "operator") => {
      const res = await app.fetch(new Request("http://app.test" + path, { method, headers: { authorization: tokens[as], "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
      const text = await res.text();
      out[key] = { status: res.status, body: text.startsWith("{") ? JSON.parse(text) : text };
    };
    await go("before", "/api/repositories");
    await go("viewerSet", "/api/repositories/checkout", "PUT", { url: "gitlab.com/acme/shop" }, "viewer");
    await go("bad", "/api/repositories/checkout", "PUT", { url: "javascript:alert(1)" });
    await go("set", "/api/repositories/checkout", "PUT", { url: "https://gitlab.com/acme/shop.git" });
    await go("override", "/api/repositories/api", "PUT", { url: "https://git.acme.dev/ops/api" });
    await go("after", "/api/repositories", "GET", undefined, "viewer");
    await go("clear", "/api/repositories/api", "DELETE");
    await go("clearAgain", "/api/repositories/api", "DELETE");
    await go("deploy", "/api/code?mark=deploy-api-1.4.2", "GET", undefined, "viewer");
    await go("version", "/api/code?service=api&version=1.4.2");
    await go("noVersion", "/api/code?service=api&version=9.9.9");
    await go("none", "/api/code?service=billing&version=1.0.0");
    await go("missing", "/api/code");
    console.log(JSON.stringify(out));
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", script], {
    cwd: fixture,
    env: { ...process.env, NODE_PATH: join(root, "../node_modules"), TOPOSCOPE_DEV: "1", TOPOSCOPE_PASSWORD: "pw", TOPOSCOPE_INGEST_TOKEN: "ingest-only", SQLITE_PATH: ":memory:", CLICKHOUSE_URL: "http://clickhouse.test", OTLP_GRPC_PORT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  r = JSON.parse(child.stdout.toString().trim().split("\n").pop()!);
});

afterAll(() => rmSync(fixture, { recursive: true, force: true }));

const row = (key: string, service: string) => (r[key]!.body.repositories as Array<{ service: string }>).find((x) => x.service === service) as any;

describe("a service's repository (#393, 37i)", () => {
  test("the resource, else the newest deploy mark's repo, else none", () => {
    expect(r.before!.status).toBe(200);
    expect(row("before", "api").repository).toEqual({ url: "https://github.com/acme/api", host: "github", name: "acme/api", from: "resource" });
    expect(row("before", "auth").repository).toMatchObject({ url: "https://github.com/acme/auth", from: "mark" });
    expect(row("before", "auth").mark).toEqual({ id: "deploy-auth-2.3.0", version: "2.3.0" });
    expect(row("before", "billing").repository).toBeNull();
  });

  test("only an Operator sets one, and only a repository", () => {
    expect(r.viewerSet!.status).toBe(403);
    expect(r.bad!.status).toBe(400);
    expect(r.bad!.body.field).toBe("url");
    expect(r.set!.status).toBe(200);
    expect(r.set!.body.repository).toEqual({ url: "https://gitlab.com/acme/shop", host: "gitlab", name: "acme/shop", from: "set" });
  });

  test("one set here wins over the resource, and says who set it", () => {
    expect(row("after", "api").repository).toMatchObject({ url: "https://git.acme.dev/ops/api", host: "gitea", from: "set" });
    expect(row("after", "api").set_by.name).toBe("ops-bot");
    expect(typeof row("after", "api").set_at).toBe("number");
  });

  test("clearing it lets the resource count again", () => {
    expect(r.clear!.status).toBe(200);
    expect(r.clear!.body.repository.from).toBe("resource");
    expect(r.clearAgain!.status).toBe(404);
  });
});

describe("GET /api/code", () => {
  test("a deploy, its repository and the previous deploy of the same service (37g)", () => {
    expect(r.deploy!.status).toBe(200);
    expect(r.deploy!.body.repository.url).toBe("https://github.com/acme/api");
    expect(r.deploy!.body.mark).toMatchObject({ id: "deploy-api-1.4.2", version: "1.4.2", sha: "4f9c1e7d" });
    expect(r.deploy!.body.previous).toMatchObject({ id: "deploy-api-1.4.1", version: "1.4.1", sha: "9e21aa03" });
  });

  test("the deploy mark of a row's version, or none (37h)", () => {
    expect(r.version!.body.mark).toMatchObject({ version: "1.4.2", sha: "4f9c1e7d" });
    expect(r.noVersion!.body.mark).toBeNull();
    expect(r.noVersion!.body.repository.name).toBe("acme/api");
    expect(r.none!.body).toEqual({ repository: null, mark: null, previous: null });
    expect(r.missing!.status).toBe(400);
  });
});
