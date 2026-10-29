import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiRoutes } from "../api/routes";
import { fenceNote, onClock, readTools, unfencedTools } from "./read";
import { nestedDeeper, originAllowed } from "./server";
import { mcpTools, toolCall, toolOf, toolRouteIds, toolsOf } from "./tools";

const root = join(import.meta.dir, "..");
const fixture = mkdtempSync(join(tmpdir(), "toposcope-mcp-"));
type Answer = { status: number; type: string | null; body: any };
let r: Record<string, any>;

// The app itself, as an agent calls it: MCP at /mcp with a service account's token (#358).
beforeAll(async () => {
  await Bun.write(join(fixture, "src/ui/dist/index.html"), "<!doctype html><html>the app</html>");
  const script = `
    import { mock, setSystemTime } from "bun:test";
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
    const people = await import(root + "/control/people.ts");
    const use = await import(root + "/access/use.ts");
    const accounts = {};
    const bearer = (name, role) => {
      accounts[name] = people.createServiceAccount({ name, role });
      return "Bearer " + people.createPersonToken(accounts[name].id, { name: "t" }).token;
    };
    const as = { operator: bearer("o", "operator"), viewer: bearer("v", "viewer"), none: undefined };
    const answer = async (res) => {
      const text = await res.text();
      return { status: res.status, type: res.headers.get("content-type"), body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text };
    };
    const api = async (who, method, path, body) => answer(await app.fetch(new Request("http://app.test" + path, {
      method, headers: { ...(as[who] ? { authorization: as[who] } : {}), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    })));
    const post = async (who, raw, headers = {}) => answer(await app.fetch(new Request("http://app.test/mcp", {
      method: "POST",
      headers: { ...(as[who] ? { authorization: as[who] } : {}), "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: raw,
    })));
    let n = 0;
    const rpc = (who, method, params, headers) => post(who, JSON.stringify({ jsonrpc: "2.0", id: ++n, method, ...(params === undefined ? {} : { params }) }), headers);
    const call = (who, name, args) => rpc(who, "tools/call", { name, arguments: args });
    const out = {};

    out.firstUse = people.tokensOf(accounts.o.id)[0].last_used_at;
    out.init = await rpc("operator", "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    out.initNewer = await rpc("operator", "initialize", { protocolVersion: "2099-01-01", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    out.initialized = await post("operator", JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    out.ping = await rpc("operator", "ping");
    out.listOperator = await rpc("operator", "tools/list");
    out.listViewer = await rpc("viewer", "tools/list");
    out.used = people.tokensOf(accounts.o.id)[0].last_used_at;

    // Every tool the Operator is shown, both ways: through MCP and straight at its route.
    const saved = (await api("operator", "POST", "/api/saved-searches", { name: "errors", query: "level:error", range: "1h" })).body;
    // A window with both ends, so the two answers read the same one.
    const day = { from: "2026-10-27T00:00:00.000Z", to: "2026-10-28T00:00:00.000Z" };
    const args = {
      search: { q: "level:error", ...day },
      saved_searches: {},
      saved_search_run: { id: saved.id },
      saved_search_test: { id: saved.id },
      monitors: day,
      monitor_get: { name: "quiet api" },
      marks: { ...day, kind: "deploy" },
      attr_keys: { q: "service:api", ...day },
      attr_values: { key: "route", prefix: "/a", ...day },
      metric_names: day,
      search_context: { ts: "2026-10-27T12:00:00.000Z", service: "api" },
      search_around: { ts: "2026-10-27T12:00:00.000Z", ...day },
      search_compare: { mark: "deploy-api-1", ...day },
      search_cut: { mark: "deploy-api-1", ...day },
      home_since: {},
      fingerprint_seen: { hex: "a91f2c", ...day },
      traces_get: { trace_id: "0af7651916cd43dd8448eb211c80319c" },
      metric_series: { name: "http.requests", ...day },
      metric_labels: { name: "http.requests", ...day },
      profiles: { trace_id: "0af7651916cd43dd8448eb211c80319c", span_id: "b7ad6b7169203331" },
      numeric_keys: { q: "service:api", ...day },
      facets: { q: "service:api", ...day },
    };
    const { mcpTools, toolCall } = await import(root + "/mcp/tools.ts");
    out.both = {};
    // The clock held still, so an answer that says when it was read says the same time both ways.
    setSystemTime(new Date("2026-10-28T12:00:00.000Z"));
    for (const tool of out.listOperator.body.result.tools) {
      const given = args[tool.name];
      if (!given) { out.both[tool.name] = { missingArgs: true }; continue; }
      const via = await call("operator", tool.name, given);
      const built = toolCall(mcpTools.find((t) => t.name === tool.name), given);
      const direct = await api("operator", built.method, built.path + (built.query.size ? "?" + built.query : ""));
      out.both[tool.name] = { via, direct };
    }
    setSystemTime();

    // A Viewer may run the Operator's tool by name: the route refuses it, in its own words, and Access counts it.
    out.viewerCall = await call("viewer", "saved_search_test", { id: saved.id });
    out.viewerDirect = await api("viewer", "POST", "/api/saved-searches/" + saved.id + "/test");
    out.viewerRefused = use.pendingAccessUse().get(use.accessKey("person", "v"));
    out.viewerReads = await call("viewer", "saved_searches", {});

    out.noToken = await rpc("none", "tools/list");
    out.apiNoToken = await api("none", "GET", "/api/saved-searches");
    out.badToken = await post("none", "{}", { authorization: "Bearer tsp_nothing" });
    out.notJson = await post("operator", "{nope");
    out.batch = await post("operator", JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]));
    out.notRpc = await post("operator", JSON.stringify({ id: 1, method: "ping" }));
    out.nullId = await post("operator", JSON.stringify({ jsonrpc: "2.0", id: null, method: "ping" }));
    out.noMethod = await rpc("operator", "tools/destroy");
    out.badParams = await post("operator", JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: [1] }));
    out.noTool = await call("operator", "drop_everything", {});
    out.badArgs = await rpc("operator", "tools/call", { name: "search", arguments: "q=x" });
    out.unknownArg = await call("operator", "search", { q: "x", rows: "all" });
    out.noPathParam = await call("operator", "monitor_get", {});
    out.badVersion = await rpc("operator", "ping", undefined, { "mcp-protocol-version": "2024-01-01" });
    out.goodVersion = await rpc("operator", "ping", undefined, { "mcp-protocol-version": "2025-11-25" });
    out.otherSite = await rpc("operator", "ping", undefined, { origin: "https://evil.example" });
    // A DNS-rebinding page: its Origin and the Host it reaches us under are the same name.
    out.rebound = await rpc("operator", "ping", undefined, { origin: "http://evil.example:8080", host: "evil.example:8080" });
    out.ownSite = await rpc("operator", "ping", undefined, { origin: "https://logs.example.com" });
    out.localSite = await rpc("operator", "ping", undefined, { origin: "http://127.0.0.1:8080" });
    out.dotDot = await call("operator", "monitor_get", { name: ".." });
    out.dot = await call("operator", "monitor_get", { name: "." });
    out.slash = await call("operator", "saved_search_run", { id: "../../me" });
    out.dotted = await call("operator", "monitor_get", { name: "a.b" });
    const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(1024 * 1024) } });
    out.tooBig = await post("operator", big);
    const stream = (text) => new ReadableStream({ start(c) { const b = new TextEncoder().encode(text); for (let i = 0; i < b.length; i += 65536) c.enqueue(b.slice(i, i + 65536)); c.close(); } });
    out.tooBigStream = await answer(await app.fetch(new Request("http://app.test/mcp", { method: "POST", headers: { authorization: as.operator, "content-type": "application/json" }, body: stream(big), duplex: "half" })));
    let deep = "x";
    for (let i = 0; i < 100; i++) deep = [deep];
    out.deep = await call("operator", "search", { q: deep });
    out.veryDeep = await post("operator", '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search","arguments":{"q":' + "[".repeat(200000) + "]".repeat(200000) + "}}}");
    out.get = await answer(await app.fetch(new Request("http://app.test/mcp", { headers: { authorization: as.operator, accept: "text/event-stream" } })));
    console.log(JSON.stringify(out));
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", script], {
    cwd: fixture,
    env: {
      ...process.env, NODE_PATH: join(root, "../node_modules"), TOPOSCOPE_DEV: "1", SQLITE_PATH: ":memory:", CLICKHOUSE_URL: "http://clickhouse.test", OTLP_GRPC_PORT: "0",
      TOPOSCOPE_PUBLIC_URL: "https://logs.example.com", PORT: "8080",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  r = JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!);
});

afterAll(() => rmSync(fixture, { recursive: true, force: true }));

const names = (a: Answer) => (a.body.result.tools as Array<{ name: string }>).map((t) => t.name);
const parsed = (a: Answer) => JSON.parse(a.body.result.content[0].text);

describe("MCP tools from the described API (#358)", () => {
  test("each default tool is a route's id, with its summary and its query's schema", () => {
    expect(mcpTools.map((t) => t.name)).toEqual(toolRouteIds);
    const search = mcpTools.find((t) => t.name === "search")!;
    // A read tool says when to use it, for an agent (#359); any other is its route's summary.
    expect(search.description).toBe(readTools.search!.description);
    const test = mcpTools.find((t) => t.name === "saved_search_test")!;
    expect(test.description).toBe(apiRoutes.find((r) => r.id === "saved_search_test")!.summary);
    expect(search.inputSchema.type).toBe("object");
    expect(Object.keys(search.inputSchema.properties as object)).toContain("q");
    expect(search.inputSchema.additionalProperties).toBe(false);
  });

  test("every route in the table can be a tool: path params, query keys and body never clash", () => {
    for (const route of apiRoutes) {
      const tool = toolOf(route);
      expect(tool.name).toMatch(/^[A-Za-z0-9_.-]{1,128}$/);
    }
    const put = toolOf(apiRoutes.find((r) => r.id === "monitor_put")!);
    expect(put.inputSchema.required).toEqual(["name", "body"]);
    expect(() => toolsOf(["no_such_route"])).toThrow("No API route no_such_route");
  });

  test("arguments become the route's request: the path filled, the query repeated, the body as JSON", () => {
    const put = toolOf(apiRoutes.find((r) => r.id === "monitor_put")!);
    const built = toolCall(put, { name: "quiet api", body: { kind: "search" } });
    expect(built).toEqual({ method: "PUT", path: "/api/monitors/quiet%20api", query: new URLSearchParams(), body: '{"kind":"search"}' });
    const search = toolOf(apiRoutes.find((r) => r.id === "search")!);
    const q = toolCall(search, { q: "x", limit: 5, keep: ["a", "b"] });
    expect("query" in q && q.query.toString()).toBe("q=x&limit=5&keep=a&keep=b");
  });
});

describe("MCP at /mcp, in the app (#358)", () => {
  test("initialize agrees on the client's revision, or offers the newest", () => {
    expect(r.init.status).toBe(200);
    expect(r.init.type).toContain("application/json");
    expect(r.init.body.jsonrpc).toBe("2.0");
    expect(r.init.body.result.protocolVersion).toBe("2025-06-18");
    expect(r.init.body.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(r.init.body.result.serverInfo.name).toBe("toposcope");
    expect(r.initNewer.body.result.protocolVersion).toBe("2025-11-25");
    expect(r.initialized.status).toBe(202);
    expect(r.ping.body.result).toEqual({});
  });

  test("tools/list shows an Operator every default tool, and a Viewer only those a Viewer may call", () => {
    expect(names(r.listOperator)).toEqual(toolRouteIds);
    expect(names(r.listViewer)).toEqual(toolRouteIds.filter((n) => n !== "saved_search_test"));
    const search = r.listOperator.body.result.tools.find((t: { name: string }) => t.name === "search");
    expect(search.annotations).toEqual({ readOnlyHint: true });
  });

  test("every listed tool gives the same answer as its route, under data, on the instance's clock", () => {
    for (const [name, both] of Object.entries(r.both as Record<string, { via: Answer; direct: Answer; missingArgs?: true }>)) {
      expect({ name, missingArgs: both.missingArgs }).toEqual({ name, missingArgs: undefined });
      expect({ name, isError: both.via.body.result.isError }).toEqual({ name, isError: both.direct.status >= 400 });
      if (both.direct.status < 400) {
        const shaped = parsed(both.via);
        expect({ name, note: shaped.note, now: shaped.now, cut: shaped.cut }).toEqual({ name, note: fenceNote, now: "2026-10-28T12:00:00.000Z", cut: undefined });
        expect({ name, body: shaped.data }).toEqual({ name, body: onClock(both.direct.body) });
      } else {
        expect({ name, body: parsed(both.via) }).toEqual({ name, body: both.direct.body });
      }
    }
    expect(r.both.saved_search_run.via.body.result.isError).toBe(false);
    expect(r.both.monitor_get.via.body.result.isError).toBe(true);
  });

  test("every tool is fenced: none opts out, a design tool's answer included", () => {
    expect([...unfencedTools]).toEqual([]);
    const test = parsed(r.both.saved_search_test.via);
    expect(Object.keys(test).sort()).toEqual(["clock", "data", "note", "now"]);
    expect(test.note).toBe(fenceNote);
    expect(readTools.saved_search_test).toBeUndefined();
  });

  test("a Viewer's call to an Operator's route is refused with the route's sentence, and Access counts it", () => {
    expect(r.viewerCall.status).toBe(200);
    expect(r.viewerCall.body.result.isError).toBe(true);
    expect(r.viewerDirect.status).toBe(403);
    expect(parsed(r.viewerCall)).toEqual(r.viewerDirect.body);
    expect(parsed(r.viewerCall).error).toBe("A Viewer may not make or change monitors and webhooks: ask an Operator");
    expect(r.viewerRefused.refused).toBe(2);
    expect(r.viewerReads.body.result.isError).toBe(false);
  });

  test("a call is counted under its token, as an API call is", () => {
    expect(r.firstUse).toBeNull();
    expect(typeof r.used).toBe("number");
  });

  test("no token, or one that matches nothing, gets the API gate's 401", () => {
    expect(r.noToken.status).toBe(401);
    expect(r.noToken.body).toEqual(r.apiNoToken.body);
    expect(r.badToken.status).toBe(401);
  });

  test("a message that is not JSON-RPC gets JSON-RPC's code for it", () => {
    expect([r.notJson.status, r.notJson.body.error.code, r.notJson.body.id]).toEqual([400, -32700, null]);
    expect([r.batch.status, r.batch.body.error.code]).toEqual([400, -32600]);
    expect([r.notRpc.status, r.notRpc.body.error.code]).toEqual([400, -32600]);
    expect([r.nullId.status, r.nullId.body.error.code]).toEqual([400, -32600]);
    expect([r.noMethod.status, r.noMethod.body.error.code]).toEqual([200, -32601]);
    expect([r.badParams.body.id, r.badParams.body.error.code]).toEqual([9, -32602]);
    expect(r.noTool.body.error.code).toBe(-32602);
    expect(r.badArgs.body.error.code).toBe(-32602);
  });

  test("an argument with no place in the route's request is the tool's error, so the agent can fix it", () => {
    expect(r.unknownArg.body.result.isError).toBe(true);
    expect(parsed(r.unknownArg)).toEqual({ error: "search takes no rows", field: "rows" });
    expect(parsed(r.noPathParam)).toEqual({ error: "name is required", field: "name" });
  });

  test("MCP-Protocol-Version and Origin are checked; GET has no stream", () => {
    expect([r.badVersion.status, r.badVersion.body.error.code]).toEqual([400, -32600]);
    expect(r.goodVersion.body.result).toEqual({});
    expect(r.otherSite.status).toBe(403);
    expect(r.rebound.status).toBe(403);
    expect(r.ownSite.body.result).toEqual({});
    expect(r.localSite.body.result).toEqual({});
    expect(r.get.status).toBe(405);
  });
});

describe("MCP's limits (#358)", () => {
  test("an Origin is this instance's public address or localhost on its port, never the request's Host", () => {
    const env = { TOPOSCOPE_PUBLIC_URL: "https://logs.example.com/toposcope", PORT: "8080" };
    expect(originAllowed(undefined, env)).toBe(true);
    expect(originAllowed("https://logs.example.com", env)).toBe(true);
    expect(originAllowed("http://logs.example.com", env)).toBe(false);
    expect(originAllowed("http://localhost:8080", env)).toBe(true);
    expect(originAllowed("http://127.0.0.1:8080", env)).toBe(true);
    expect(originAllowed("http://[::1]:8080", env)).toBe(true);
    expect(originAllowed("http://127.0.0.1:6274", env)).toBe(false);
    expect(originAllowed("http://evil.example:8080", env)).toBe(false);
    expect(originAllowed("null", env)).toBe(false);
    expect(originAllowed("http://localhost:8080", {})).toBe(true);
    expect(originAllowed("https://logs.example.com", {})).toBe(false);
  });

  test("nesting is counted without recursion: 64 deep is taken, 65 is not", () => {
    const nest = (n: number) => {
      let v: unknown = "x";
      for (let i = 0; i < n; i++) v = [v];
      return v;
    };
    expect(nestedDeeper(nest(64), 64)).toBe(false);
    expect(nestedDeeper(nest(65), 64)).toBe(true);
    expect(nestedDeeper(nest(500_000), 64)).toBe(true);
  });

  test("a path param is one segment: . and .. and a / are the tool's error, and the call goes nowhere else", () => {
    expect(parsed(r.dotDot)).toEqual({ error: "name may not be . or .. or hold a /", field: "name" });
    expect(parsed(r.dot).field).toBe("name");
    expect(parsed(r.slash)).toEqual({ error: "id may not be . or .. or hold a /", field: "id" });
    expect(r.dotDot.body.result.isError).toBe(true);
    expect(parsed(r.dotted)).toEqual({ error: "Monitor not found" });
  });

  test("a body past 1 MiB is a 413 before it is read as JSON, with or without Content-Length", () => {
    expect([r.tooBig.status, r.tooBig.body.error.code, r.tooBig.body.id]).toEqual([413, -32600, null]);
    expect([r.tooBigStream.status, r.tooBigStream.body.error.code]).toEqual([413, -32600]);
  });

  test("params nested past 64 deep are -32602, not a stack overflow", () => {
    expect([r.deep.status, r.deep.body.error.code]).toEqual([200, -32602]);
    expect(r.deep.body.error.message).toBe("params nest at most 64 deep");
    expect(r.veryDeep.body.error.code).toBe(-32602);
  });
});
