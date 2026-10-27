import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionFor, actionRole, refusalWords, routeActions } from "./control/roles";

const root = import.meta.dir;
const fixture = mkdtempSync(join(tmpdir(), "toposcope-roles-"));
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
      throw new Error("Unexpected external fetch " + url);
    };
    const app = (await import(root + "/index.ts")).default;
    for (let i = 0; i < 50; i++) {
      if ((await app.fetch(new Request("http://app.test/api/health"))).status === 200) break;
      await new Promise((ok) => setTimeout(ok, 0));
    }
    const people = await import(root + "/control/people.ts");
    const bearer = (name, role, readOnly = false) => {
      const account = people.createServiceAccount({ name, role });
      return "Bearer " + people.createPersonToken(account.id, { name: "t", read_only: readOnly }).token;
    };
    const as = { viewer: bearer("v", "viewer"), operator: bearer("o", "operator"), owner: bearer("w", "owner"), readonly: bearer("ro", "owner", true) };
    const out = {};
    const go = async (key, who, path, method = "GET", body) => {
      const res = await app.fetch(new Request("http://app.test" + path, { method, headers: { authorization: as[who], "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
      const text = await res.text();
      out[key] = { status: res.status, body: text.startsWith("{") ? JSON.parse(text) : text };
      return out[key];
    };
    // Reading is everyone's.
    await go("viewerReads", "viewer", "/api/saved-searches");
    await go("viewerMonitors", "viewer", "/api/monitors");
    // Saving: a Viewer's own hunt is theirs alone; an Operator's is shared.
    const mine = (await go("viewerSaves", "viewer", "/api/saved-searches", "POST", { name: "my timeouts", query: "level:error", range: "1h", pinned: true })).body;
    await go("viewerShares", "viewer", "/api/saved-searches", "POST", { name: "for all", query: "x", range: "1h", shared: true });
    const team = (await go("operatorSaves", "operator", "/api/saved-searches", "POST", { name: "errors on billing", query: "service:billing level:error", range: "1h" })).body;
    await go("operatorList", "operator", "/api/saved-searches");
    await go("viewerList", "viewer", "/api/saved-searches");
    await go("viewerPinsTeam", "viewer", "/api/saved-searches/" + team.id, "PUT", { pinned: true });
    await go("viewerEditsTeam", "viewer", "/api/saved-searches/" + team.id, "PUT", { name: "renamed" });
    await go("operatorSeesMine", "operator", "/api/saved-searches/" + mine.id, "PUT", { name: "x" });
    await go("viewerDeletesTeam", "viewer", "/api/saved-searches/" + team.id, "DELETE");
    await go("operatorList2", "operator", "/api/saved-searches");
    // The table's other rows.
    await go("viewerMonitor", "viewer", "/api/monitors/quiet-api", "PUT", { kind: "search" });
    await go("viewerFields", "viewer", "/api/fields", "PUT", { roles: {}, links: {} });
    await go("operatorFields", "operator", "/api/fields", "PUT", { roles: {}, links: {} });
    await go("viewerNote", "viewer", "/v1/marks", "POST", { kind: "note", title: "hi" });
    await go("operatorSettings", "operator", "/api/settings", "PUT", { retention_days: 14 });
    await go("operatorToken", "operator", "/api/api-tokens", "POST", { name: "box" });
    await go("operatorAccess", "operator", "/api/access");
    await go("viewerAccess", "viewer", "/api/access");
    await go("operatorNewShare", "operator", "/api/shares/console", "PUT", { panels: [] });
    const panel = { name: "errors", params: { agg: "count", split: "level", range: "24h" } };
    await go("ownerShare", "owner", "/api/shares/console", "PUT", { logs: "service:api", panels: [panel], expires_at: "2027-10-01" });
    await go("operatorAddsPanel", "operator", "/api/shares/console", "PUT", { panels: [panel, { name: "errors-week", params: { agg: "count", split: "level", range: "7d" } }] });
    await go("operatorOutside", "operator", "/api/shares/console", "PUT", { panels: [panel, { name: "by-host", params: { agg: "count", split: "host", range: "24h" } }] });
    await go("operatorWidens", "operator", "/api/shares/console", "PUT", { panels: [panel], expires_at: "2028-10-01" });
    await go("ownerSettings", "owner", "/api/settings", "PUT", { retention_days: 30 });
    await go("ownerToken", "owner", "/api/api-tokens", "POST", { name: "box" });
    await go("readonlyWrites", "readonly", "/api/settings", "PUT", { retention_days: 30 });
    await go("readonlyReads", "readonly", "/api/settings");
    await go("me", "readonly", "/api/me");
    // #307: who made what.
    await go("madeMonitor", "operator", "/api/alert-rules", "POST", { name: "errors up", saved_search_id: team.id, threshold: 5, webhook_url: "https://hooks.example.com/x" });
    await go("monitorsAfter", "viewer", "/api/monitors");
    await go("settingsAfter", "viewer", "/api/settings");
    await go("savedAfter", "viewer", "/api/saved-searches");
    console.log(JSON.stringify(out));
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", script], {
    cwd: fixture,
    env: { ...process.env, NODE_PATH: join(root, "../node_modules"), TOPOSCOPE_DEV: "1", TOPOSCOPE_INGEST_TOKEN: "ingest-only", SQLITE_PATH: ":memory:", CLICKHOUSE_URL: "http://clickhouse.test", OTLP_GRPC_PORT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  r = JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!);
});

afterAll(() => rmSync(fixture, { recursive: true, force: true }));

describe("the role table on every route (#306, 30d)", () => {
  test("every /api route the app registers is in the table", () => {
    const index = readFileSync(join(root, "index.ts"), "utf8");
    const open = new Set(["POST /api/sign-in", "POST /api/setup", "GET /api/health", "GET /api/metrics", "POST /api/ingest"]);
    const routes = [...index.matchAll(/app\.(get|post|put|delete)\("(\/api\/[^"]*)"/g)].map((m) => `${m[1]!.toUpperCase()} ${m[2]}`);
    expect(routes.length).toBeGreaterThan(60);
    const missing = routes.filter((route) => !open.has(route) && !routeActions.some(([m, p]) => `${m} ${p}` === route));
    expect(missing).toEqual([]);
  });

  test("a fixed path wins over a :param on the same prefix", () => {
    expect(actionFor("GET", "/api/monitors/preview")).toBe("read");
    expect(actionFor("PUT", "/api/monitors/quiet-api")).toBe("change monitors");
    expect(actionFor("GET", "/api/nothing-here")).toBeNull();
  });

  test("refusals say who may, in words", () => {
    expect(refusalWords("viewer", "change monitors")).toBe("A Viewer may not make or change monitors and webhooks: ask an Operator");
    expect(refusalWords("operator", "change instance settings")).toBe("An Operator may not change retention, sign-in or instance settings: ask an Owner");
    expect(actionRole["write notes"]).toBe("operator");
  });

  test("a Viewer reads, and saves only their own hunts", () => {
    expect(r.viewerReads!.status).toBe(200);
    expect(r.viewerMonitors!.status).toBe(200);
    expect(r.viewerSaves!.status).toBe(201);
    expect(r.viewerSaves!.body).toMatchObject({ shared: false, pinned: true });
    expect(r.viewerShares!.status).toBe(403);
    expect(r.operatorSaves!.body.shared).toBe(true);
    // Only its owner sees a hunt that is not shared.
    expect(r.operatorList!.body.searches.map((s: { name: string }) => s.name)).toEqual(["errors on billing"]);
    expect(r.viewerList!.body.searches.map((s: { name: string }) => s.name).sort()).toEqual(["errors on billing", "my timeouts"]);
    expect(r.operatorSeesMine!.status).toBe(404);
  });

  test("pins are each person's own; changing or deleting another's hunt is refused", () => {
    expect(r.viewerPinsTeam!.status).toBe(200);
    expect(r.viewerPinsTeam!.body.pinned).toBe(true);
    expect(r.operatorList2!.body.searches[0].pinned).toBe(false);
    expect(r.viewerEditsTeam!.status).toBe(403);
    expect(r.viewerDeletesTeam!.status).toBe(403);
  });

  test("monitors, notes and Fields take an Operator", () => {
    expect(r.viewerMonitor!.status).toBe(403);
    expect(r.viewerMonitor!.body).toEqual({ error: "A Viewer may not make or change monitors and webhooks: ask an Operator", need: "operator" });
    expect(r.viewerFields!.status).toBe(403);
    expect(r.operatorFields!.status).toBe(200);
    expect(r.viewerNote!.status).toBe(403);
  });

  test("settings, tokens and new shares take an Owner; an Operator sees Access, a Viewer does not", () => {
    expect(r.operatorSettings!.status).toBe(403);
    expect(r.operatorToken!.status).toBe(403);
    expect(r.operatorAccess!.status).toBe(200);
    expect(r.viewerAccess!.status).toBe(403);
    expect(r.operatorNewShare!.status).toBe(403);
    expect(r.operatorNewShare!.body.error).toContain("An Operator may not make a share");
    expect(r.ownerSettings!.status).toBe(200);
    expect(r.ownerToken!.status).toBe(201);
  });

  test("an Operator adds panels to an existing share, and changes nothing else", () => {
    expect([200, 201]).toContain(r.ownerShare!.status);
    expect(r.operatorAddsPanel!.status).toBe(200);
    expect(r.operatorAddsPanel!.body.share.panels.map((p: { name: string }) => p.name)).toEqual(["errors", "errors-week"]);
    // The fence stays the share's: a panel that splits by something it does not list is refused.
    expect(r.operatorOutside!.status).toBe(400);
    expect(r.operatorOutside!.body.error).toContain("does not cover the panels");
    expect(r.operatorWidens!.status).toBe(403);
    expect(r.operatorWidens!.body.error).toContain("expires_at takes an Owner");
  });

  test("every write records its actor, by name (#307)", () => {
    expect(r.madeMonitor!.status).toBe(201);
    const made = r.monitorsAfter!.body.monitors.find((m: { name: string }) => m.name === "errors up");
    expect(made.made_by).toMatchObject({ name: "o", kind: "service" });
    expect(r.settingsAfter!.body.changed_by.retention_days.by).toMatchObject({ name: "w" });
    const team = r.savedAfter!.body.searches.find((s: { name: string }) => s.name === "errors on billing");
    expect(team.saved_by).toMatchObject({ name: "o" });
  });

  test("a read-only token acts as a Viewer whatever its person's role", () => {
    expect(r.readonlyWrites!.status).toBe(403);
    expect(r.readonlyReads!.status).toBe(200);
    expect(r.me!.body).toMatchObject({ role: "viewer", person_role: "owner" });
  });
});
