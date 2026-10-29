import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const fixture = mkdtempSync(join(tmpdir(), "toposcope-api-"));
type Answer = { status: number; body: any };
let r: { refused: Record<string, Answer>; missing: Record<string, Answer>; spec: Answer; specMatches: boolean; viewer: Answer; taken: Record<string, Answer>; wrong: Record<string, Answer> };

// The app itself, as a token calls it: every route with a body refuses one its schema refuses (#356).
beforeAll(async () => {
  await Bun.write(join(fixture, "src/ui/dist/index.html"), "<!doctype html><html>the app</html>");
  const script = `
    import { mock } from "bun:test";
    const root = ${JSON.stringify(root)};
    const migrate = await import(root + "/shared/migrate.ts");
    mock.module(root + "/shared/migrate.ts", () => ({ ...migrate, migrateStore: async () => {}, syncFieldRoleSkip: async () => {}, applyRetentionDays: async () => {} }));
    mock.module(root + "/alerts/cron.ts", () => ({ startAlertCron() {} }));
    mock.module(root + "/alerts/http-cron.ts", () => ({ startHttpMonitors() {} }));
    mock.module(root + "/ingest/syslog.ts", () => ({ startSyslogUdp: async () => {} }));
    globalThis.fetch = async (url) => {
      if (String(url).startsWith("http://clickhouse.test")) return Response.json({ data: [] });
      throw new Error("Unexpected external fetch " + url);
    };
    const app = (await import(root + "/index.ts")).default;
    for (let i = 0; i < 50; i++) {
      if ((await app.fetch(new Request("http://app.test/api/health"))).status === 200) break;
      await new Promise((ok) => setTimeout(ok, 0));
    }
    const { apiRoutes, openApi } = await import(root + "/api/routes.ts");
    const people = await import(root + "/control/people.ts");
    const bearer = (name, role) => "Bearer " + people.createPersonToken(people.createServiceAccount({ name, role }).id, { name: "t" }).token;
    const owner = bearer("w", "owner");
    const viewer = bearer("v", "viewer");
    const call = async (method, path, body, who = owner) => {
      const res = await app.fetch(new Request("http://app.test" + path, { method, headers: { authorization: who, "content-type": "application/json" }, body }));
      const text = await res.text();
      return { status: res.status, body: text.startsWith("{") ? JSON.parse(text) : text };
    };
    const at = (path) => path.replace(/:[a-z_]+/g, "x");
    const refused = {};
    const missing = {};
    for (const route of apiRoutes) {
      if (route.body) {
        refused[route.method + " " + route.path] = await call(route.method, at(route.path), "42");
      }
      const required = Object.entries(route.query?.entries ?? {}).filter(([, s]) => s.type !== "optional");
      if (required.length > 0) {
        missing[route.method + " " + route.path] = await call(route.method, at(route.path));
      }
    }
    // What main took stays taken: an empty choice is absent, null is absent where the handler reads it so.
    const account = people.createServiceAccount({ name: "bot", role: "viewer" });
    const taken = {
      marksKindEmpty: await call("GET", "/api/marks?range=1h&kind="),
      marksKindCase: await call("GET", "/api/marks?range=1h&kind=%20Deploy%20"),
      fieldsWaveEmpty: await call("GET", "/api/fields?wave="),
      offerKindsNull: await call("POST", "/api/links/offer", JSON.stringify({ name: "here", kinds: null, q: null })),
      offerNull: await call("POST", "/api/links/offer", "null"),
      tokenDaysNull: await call("POST", "/api/people/" + account.id + "/tokens", JSON.stringify({ name: "t", expires_in_days: null, read_only: null })),
      savedNulls: await call("POST", "/api/saved-searches", JSON.stringify({ name: "s", query: null, pinned: null })),
    };
    // A wrong type main turned into a default is refused, naming the field.
    const wrong = {
      tokenDaysText: await call("POST", "/api/people/" + account.id + "/tokens", JSON.stringify({ name: "t", expires_in_days: "30" })),
      enabledText: await call("PUT", "/api/alert-rules/x", JSON.stringify({ enabled: "false" })),
      marksKindOther: await call("GET", "/api/marks?range=1h&kind=release"),
    };
    const spec = await call("GET", "/api/openapi.json");
    const viewerAnswer = await call("PUT", "/api/settings", "42", viewer);
    console.log(JSON.stringify({ refused, missing, spec, specMatches: JSON.stringify(spec.body) === JSON.stringify(openApi()), viewer: viewerAnswer, taken, wrong }));
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", script], {
    cwd: fixture,
    env: { ...process.env, NODE_PATH: join(root, "../node_modules"), TOPOSCOPE_DEV: "1", SQLITE_PATH: ":memory:", CLICKHOUSE_URL: "http://clickhouse.test", OTLP_GRPC_PORT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  r = JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!);
});

afterAll(() => rmSync(fixture, { recursive: true, force: true }));

describe("the described API in the app (#356)", () => {
  test("every route with a body refuses one its schema refuses: a 400, { error }, and nothing else", () => {
    const routes = Object.entries(r.refused);
    expect(routes.length).toBeGreaterThan(20);
    for (const [route, answer] of routes) {
      expect({ route, status: answer.status }).toEqual({ route, status: 400 });
      expect({ route, body: answer.body }).toEqual({ route, body: { error: "The body must be an object, not 42" } });
    }
  });

  test("a query key a route cannot do without is refused with its field", () => {
    const routes = Object.entries(r.missing);
    expect(routes.length).toBeGreaterThan(5);
    for (const [route, answer] of routes) {
      expect({ route, status: answer.status }).toEqual({ route, status: 400 });
      expect(Object.keys(answer.body).sort()).toEqual(["error", "field"]);
      expect(typeof answer.body.error).toBe("string");
    }
    expect(r.missing["GET /api/search/cut"]!.body).toEqual({ error: "mark is required", field: "mark" });
  });

  test("what main took is still taken: an empty choice, any case of a mark's kind, and null for left out", () => {
    for (const [name, answer] of Object.entries(r.taken)) {
      expect({ name, status: answer.status, body: answer.status >= 400 ? answer.body : null }).toEqual({ name, status: name === "marksKindEmpty" || name === "marksKindCase" || name === "fieldsWaveEmpty" ? 200 : 201, body: null });
    }
  });

  test("a wrong type main turned into a default is refused, with its field", () => {
    expect(r.wrong.tokenDaysText).toEqual({ status: 400, body: { error: 'expires_in_days must be number, not "30"', field: "expires_in_days" } });
    expect(r.wrong.enabledText).toEqual({ status: 400, body: { error: 'enabled must be boolean or number, not "false"', field: "enabled" } });
    expect(r.wrong.marksKindOther).toEqual({ status: 400, body: { error: "kind must be deploy, flag, incident, or note", field: "kind" } });
  });

  test("GET /api/openapi.json serves the spec the table builds", () => {
    expect(r.spec.status).toBe(200);
    expect(r.spec.body.openapi).toBe("3.1.0");
    expect(r.specMatches).toBe(true);
  });

  test("the role check comes first: a Viewer is refused the route, not the body", () => {
    expect(r.viewer.status).toBe(403);
    expect(r.viewer.body.need).toBe("owner");
  });
});
