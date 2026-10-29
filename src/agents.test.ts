import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { roleOf } from "./api/registry";
import { apiRoutes } from "./api/routes";
import { designToolRouteIds } from "./mcp/tools";

/** An agent is a service account (#357, frames 34a–34c). */
const root = import.meta.dir;
const fixture = mkdtempSync(join(tmpdir(), "toposcope-agents-"));
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
    const owner = (await import(root + "/control/owner-for-tests.ts")).ownerBearer();
    const out = {};
    const go = async (key, path, method = "GET", body, as = owner) => {
      const res = await app.fetch(new Request("http://app.test" + path, { method, headers: { authorization: as, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
      const text = await res.text();
      out[key] = { status: res.status, body: text.startsWith("{") ? JSON.parse(text) : text };
      return out[key];
    };
    const made = await go("made", "/api/people/agents", "POST", { name: "claude", role: "operator" });
    await go("again", "/api/people/agents", "POST", { name: "claude", role: "operator" });
    await go("otherRole", "/api/people/agents", "POST", { name: "claude", role: "viewer" });
    await go("asOwner", "/api/people/agents", "POST", { name: "boss", role: "owner" });
    await go("badName", "/api/people/agents", "POST", { name: "agent: claude", role: "operator" });
    await go("promoted", "/api/people/" + made.body.agent.id, "PUT", { role: "owner" });
    await go("demoted", "/api/people/" + made.body.agent.id, "PUT", { role: "viewer" });
    await go("backToOperator", "/api/people/" + made.body.agent.id, "PUT", { role: "operator" });
    // What the agent saves, with its token: a saved hunt and a monitor on it.
    const agent = "Bearer " + made.body.token;
    await go("agentMe", "/api/me", "GET", undefined, agent);
    const saved = await go("agentSaves", "/api/saved-searches", "POST", { name: "errors on api", query: "service:api level:error", range: "15m" }, agent);
    // A save with a token is previewed first (#360).
    const watched = { service: "api", source: "search", saved_search_id: saved.body.id, threshold: 5, webhook_url: "https://hooks.example.com/page" };
    await go("agentPreviews", "/api/monitors/preview", "POST", { ...watched, name: "errors on api" }, agent);
    await go("agentWatches", "/api/monitors/errors%20on%20api", "PUT", watched, agent);
    await go("agentLetsIn", "/api/people/agents", "POST", { name: "another", role: "viewer" }, agent);
    await go("agentMakesToken", "/api/people/" + made.body.agent.id + "/tokens", "POST", { name: "more" }, agent);
    // Through MCP (#358) with the agent's token: its tools, and a monitor saved after its preview.
    let rpc = 0;
    const mcp = async (key, method, params) => {
      const res = await app.fetch(new Request("http://app.test/mcp", { method: "POST", headers: { authorization: agent, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method, params }) }));
      const text = await res.text();
      out[key] = { status: res.status, body: text.startsWith("{") ? JSON.parse(text) : text };
      return out[key];
    };
    await mcp("mcpList", "tools/list", {});
    const viaMcp = { source: "search", service: "api", saved_search_id: saved.body.id, threshold: 7, webhook_urls: ["https://hooks.example.com/page"] };
    await mcp("mcpPreview", "tools/call", { name: "monitor_draft_preview", arguments: { body: { ...viaMcp, name: "errors via mcp" } } });
    await mcp("mcpSaved", "tools/call", { name: "monitor_put", arguments: { name: "errors via mcp", body: viaMcp } });
    // A Viewer agent reads and saves its own hunts, and changes no monitor.
    const reader = await go("viewer", "/api/people/agents", "POST", { name: "reader", role: "viewer" });
    await go("viewerWatches", "/api/monitors/x", "PUT", { service: "api", source: "search", saved_search_id: saved.body.id, threshold: 5, webhook_url: "https://hooks.example.com/page" }, "Bearer " + reader.body.token);
    await go("monitors", "/api/monitors");
    await go("saved", "/api/saved-searches");
    await go("people", "/api/people");
    // Revoked: its token stops; what it saved stays, under its name.
    await go("revoke", "/api/people/" + made.body.agent.id, "DELETE");
    await go("agentAfter", "/api/me", "GET", undefined, agent);
    await go("monitorsAfter", "/api/monitors");
    console.log(JSON.stringify(out));
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

describe("an agent is a service account (#357)", () => {
  test("Let someone in › Agent makes agent: <name> and its token, shown once", () => {
    expect(r.made!.status).toBe(201);
    expect(r.made!.body.token).toMatch(/^tsp1_/);
    expect(r.made!.body.agent).toMatchObject({ kind: "service", agent: true, name: "agent: claude", role: "operator", signs_in_with: "tokens only" });
    expect(r.made!.body.agent.tokens).toHaveLength(1);
    expect(r.made!.body.kept).toBe(false);
    expect(r.badName!.status).toBe(400);
  });

  test("the same name again is the same agent with another token; in another role it is refused", () => {
    expect(r.again!.status).toBe(201);
    expect(r.again!.body.kept).toBe(true);
    expect(r.again!.body.agent.id).toBe(r.made!.body.agent.id);
    expect(r.again!.body.agent.tokens).toHaveLength(2);
    expect(r.again!.body.token).not.toBe(r.made!.body.token);
    expect(r.otherRole!.status).toBe(409);
    expect(r.otherRole!.body.error).toBe("agent: claude is an Operator: revoke it first, or name another agent");
  });

  test("a Viewer or an Operator, never an Owner", () => {
    expect(r.asOwner!.status).toBe(400);
    expect(r.asOwner!.body.error).toBe("An agent is a Viewer or an Operator, never an Owner");
    expect(r.promoted!.status).toBe(409);
    expect(r.promoted!.body.error).toBe("An agent is a Viewer or an Operator, never an Owner");
    expect(r.demoted!.status).toBe(200);
    expect(r.backToOperator!.status).toBe(200);
    expect(r.viewer!.status).toBe(201);
    expect(r.viewerWatches!.status).toBe(403);
  });

  test("an Operator agent may do what an Operator may, and never let anyone in", () => {
    expect(r.agentMe!.body).toMatchObject({ kind: "service", name: "agent: claude", role: "operator", via: "token" });
    expect(r.agentSaves!.status).toBe(201);
    expect(r.agentPreviews!.status).toBe(200);
    expect([200, 201]).toContain(r.agentWatches!.status);
    expect(r.agentLetsIn!.status).toBe(403);
    expect(r.agentMakesToken!.status).toBe(403);
  });

  test("a monitor saved with an agent's token carries its badge", () => {
    const monitor = r.monitors!.body.monitors.find((m: { name: string }) => m.name === "errors on api");
    expect(monitor.made_by).toMatchObject({ name: "agent: claude", kind: "service", agent: true });
    const hunt = r.saved!.body.searches.find((s: { name: string }) => s.name === "errors on api");
    expect(hunt.saved_by).toMatchObject({ name: "agent: claude", agent: true });
  });

  test("through MCP an Operator agent has the design tools and no Owner route, and a monitor it saves wears its badge", () => {
    expect(r.mcpList!.status).toBe(200);
    const names: string[] = r.mcpList!.body.result.tools.map((t: { name: string }) => t.name);
    for (const id of designToolRouteIds()) {
      expect(names).toContain(id);
    }
    const ownerOnly = apiRoutes.filter((route) => roleOf(route) === "owner").map((route) => route.id);
    expect(ownerOnly).toContain("people_agent_create");
    expect(names.filter((n) => ownerOnly.includes(n))).toEqual([]);
    expect(r.mcpPreview!.body.result.isError).toBeFalsy();
    expect(r.mcpSaved!.body.result.isError).toBeFalsy();
    const monitor = r.monitors!.body.monitors.find((m: { name: string }) => m.name === "errors via mcp");
    expect(monitor.made_by).toMatchObject({ name: "agent: claude", agent: true });
  });

  test("Access lists agents in a group of their own, with what each saved", () => {
    const body = r.people!.body;
    expect(body.service_accounts.map((p: { name: string }) => p.name)).toEqual(["tests"]);
    expect(body.agents.map((p: { name: string }) => p.name)).toEqual(["agent: claude", "agent: reader"]);
    expect(body.agents[0]).toMatchObject({ role: "operator", agent: true, made_on_host: false, saved: { monitors: 2, home_panels: 1, hunts: 0 } });
    expect(body.agents[0].tokens).toHaveLength(2);
    expect(body.agents[1]).toMatchObject({ role: "viewer", saved: { monitors: 0, home_panels: 0, hunts: 0 } });
  });

  test("revoked, its token stops and what it saved stays under its name", () => {
    expect(r.revoke!.status).toBe(200);
    expect(r.agentAfter!.status).toBe(401);
    const monitor = r.monitorsAfter!.body.monitors.find((m: { name: string }) => m.name === "errors on api");
    expect(monitor.made_by).toMatchObject({ name: "agent: claude", agent: true, revoked: true });
  });
});
