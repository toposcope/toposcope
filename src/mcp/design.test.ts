import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { roleOf } from "../api/registry";
import { apiRoutes } from "../api/routes";
import { refusalWords } from "../control/roles";
import { bodyHash, monitorDraft } from "../design/preview-gate";
import { designToolRouteIds } from "./tools";

const root = join(import.meta.dir, "..");
const fixture = mkdtempSync(join(tmpdir(), "toposcope-design-"));
type Answer = { status: number; body: any };
let r: Record<string, any>;

// The design tools (#360), as an agent calls them: MCP at /mcp with an Operator service account's
// token, against ClickHouse with rows seeded for `service:api level:error`.
beforeAll(async () => {
  await Bun.write(join(fixture, "src/ui/dist/index.html"), "<!doctype html><html>the app</html>");
  const script = `
    import { mock, setSystemTime } from "bun:test";
    const root = ${JSON.stringify(root)};
    mock.module(root + "/alerts/cron.ts", () => ({ startAlertCron() {} }));
    mock.module(root + "/alerts/http-cron.ts", () => ({ startHttpMonitors() {} }));
    mock.module(root + "/ingest/syslog.ts", () => ({ startSyslogUdp: async () => {} }));
    const clickhouse = process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123";
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url instanceof Request ? url.url : url).startsWith(clickhouse)) return realFetch(url, init);
      throw new Error("Unexpected external fetch " + url);
    };
    const ch = await import(root + "/shared/clickhouse.ts");
    if (!(await ch.pingClickHouse())) throw new Error("ClickHouse is required for the design tools' previews");
    const app = (await import(root + "/index.ts")).default;
    for (let i = 0; i < 400; i++) {
      if ((await app.fetch(new Request("http://app.test/api/health"))).status === 200) break;
      await new Promise((ok) => setTimeout(ok, 25));
    }
    const people = await import(root + "/control/people.ts");
    const as = {};
    const bearer = (name, role) => {
      const account = people.createServiceAccount({ name, role });
      as[name] = "Bearer " + people.createPersonToken(account.id, { name: "t" }).token;
      return account;
    };
    const agent = bearer("agent", "operator");
    bearer("viewer", "viewer");
    const answer = async (res) => {
      const text = await res.text();
      return { status: res.status, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text };
    };
    const api = async (who, method, path, body) => answer(await app.fetch(new Request("http://app.test" + path, {
      method, headers: { ...(as[who] ? { authorization: as[who] } : {}), ...(who.startsWith("cookie:") ? { cookie: who.slice(7) } : {}), "content-type": "application/json", origin: "http://app.test" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })));
    let n = 0;
    const call = async (who, name, args) => {
      const res = await answer(await app.fetch(new Request("http://app.test/mcp", {
        method: "POST",
        headers: { authorization: as[who], "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } }),
      })));
      const result = res.body.result;
      const parsed = result ? JSON.parse(result.content[0].text) : res.body;
      // A tool's 2xx answer is fenced (#359): the route's JSON is under data, beside the note.
      const fenced = !result?.isError && parsed && typeof parsed === "object" && "note" in parsed && "data" in parsed;
      return { isError: result?.isError ?? null, fenced, body: fenced ? parsed.data : parsed };
    };
    const out = {};

    // Seeded rows: a burst of errors from service:api two hours ago, in one 5-minute bar.
    const now = Date.now();
    const bar = Math.floor((now - 2 * 3_600_000) / 300_000) * 300_000;
    const tag = String(now);
    const rows = [];
    for (let i = 0; i < 400; i++) {
      const ts = new Date(bar + 30_000 + (i % 200) * 1000).toISOString();
      rows.push(JSON.stringify({ tenant_id: "default", ts: ch.toClickHouseDateTime(ts), service: "api", host: "design-" + tag, level: "error", message: "checkout failed " + i, attrs: JSON.stringify({ run: tag }), attr_map: { run: tag }, trace_id: "" }));
    }
    await ch.clickhouseInsertJsonEachRow(rows.join("\\n"), "logs");
    out.bar = new Date(bar).toISOString();

    out.list = (await answer(await app.fetch(new Request("http://app.test/mcp", {
      method: "POST", headers: { authorization: as.agent, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list" }),
    })))).body.result.tools;

    // A saved search, previewed first, then saved: its answer has its link and its undo.
    const search = { name: "api errors " + tag, query: "service:api level:error", range: "5m" };
    out.searchPreview = await call("agent", "saved_search_preview", { body: search });
    out.searchSaved = await call("agent", "saved_search_create", { body: search });
    const savedId = out.searchSaved.body.id;

    // A monitor on it, from tools alone.
    const name = "api errors up " + tag;
    const monitor = { source: "search", service: "api", saved_search_id: savedId, threshold: 300, webhook_urls: ["https://hooks.example.com/page"] };
    out.unpreviewed = await call("agent", "monitor_put", { name, body: monitor });
    out.preview = await call("agent", "monitor_draft_preview", { body: { ...monitor, name } });
    // Key order and spaces around text are not a change.
    out.saved = await call("agent", "monitor_put", { name: " " + name, body: { threshold: 300, saved_search_id: savedId, service: " api ", source: "search", webhook_urls: ["https://hooks.example.com/page"] } });
    out.listed = await call("agent", "monitors", {});
    out.undoMade = await call("agent", out.saved.body.undo.tool, out.saved.body.undo.arguments);
    out.goneAfterUndo = await call("agent", "monitor_get", { name });

    // A body changed after its preview is refused; so is a preview older than 10 minutes.
    await call("agent", "monitor_draft_preview", { body: { ...monitor, name } });
    out.changed = await call("agent", "monitor_put", { name, body: { ...monitor, threshold: 301 } });
    setSystemTime(new Date(Date.now() + 11 * 60_000));
    out.stale = await call("agent", "monitor_put", { name, body: monitor });
    setSystemTime();
    // Previewed again: saved, then changed (previewed too), then put back by the undo it was given, with no preview.
    await call("agent", "monitor_draft_preview", { body: { ...monitor, name } });
    out.again = await call("agent", "monitor_put", { name, body: monitor });
    await call("agent", "monitor_draft_preview", { body: { ...monitor, threshold: 500, name } });
    out.change = await call("agent", "monitor_put", { name, body: { ...monitor, threshold: 500 } });
    out.undoChange = await call("agent", out.change.body.undo.tool, out.change.body.undo.arguments);
    out.afterUndoChange = await call("agent", "monitor_get", { name });
    // Pausing or silencing is not a design: no preview.
    out.pause = await api("agent", "PUT", "/api/alert-rules/" + out.again.body.id, { enabled: false });
    // A change by id with a token is held too; its preview names the id.
    out.byIdUnpreviewed = await api("agent", "PUT", "/api/alert-rules/" + out.again.body.id, { threshold: 400 });
    out.byIdPreview = await call("agent", "monitor_draft_preview", { body: { id: out.again.body.id, threshold: 400 } });
    out.byIdSaved = await api("agent", "PUT", "/api/alert-rules/" + out.again.body.id, { threshold: 400 });

    // Every kind previews; those with no past say why.
    out.kinds = {};
    for (const [kind, body] of Object.entries({
      share: { source: "search", service: "api", saved_search_id: savedId, threshold: 5, measure: "share", webhook_urls: ["default"] },
      fewer: { source: "search", service: "api", saved_search_id: savedId, threshold: 1, opens_when: "fewer_than", webhook_urls: ["default"] },
      fingerprints: { source: "fingerprints", service: "api", saved_search_id: savedId, threshold: 1, webhook_urls: ["default"] },
      push: { source: "push", service: "backup", every: "1d", grace: "1h" },
      http: { source: "http", service: "api", url: "https://api.example.com/health", every: "1m", conditions: ["status == 200"] },
      tcp: { source: "tcp", service: "db", target: "db.example.com:5432", every: "1m" },
      cert: { source: "cert", service: "api", target: "api.example.com:443", every: "1h" },
    })) {
      out.kinds[kind] = await call("agent", "monitor_draft_preview", { body: { ...body, name: kind + " " + tag } });
    }
    out.badPreview = await call("agent", "monitor_draft_preview", { body: { name: "x " + tag, source: "search", service: "api", saved_search_id: savedId, threshold: 1, remind_every: "2h", webhook_urls: ["default"] } });

    // The security review's cases (#360).
    const put = async (n, body) => {
      await call("agent", "monitor_draft_preview", { body: { ...body, name: n } });
      return call("agent", "monitor_put", { name: n, body });
    };
    // (a) A body the draft refuses is refused by the gate, never passed on: an HTTP(S) monitor never becomes a TCP one.
    const httpName = "health " + tag;
    out.http = await put(httpName, { source: "http", service: "api", url: "https://api.example.com/health", every: "1m", headers: { Authorization: "Bearer one", "X-Team": "core" }, webhook_url: "https://hooks.example.com/page" });
    out.toTcp = await api("agent", "PUT", "/api/alert-rules/" + out.http.body.id, { source: "tcp", url: "https://evil.example.com/", webhook_url: "https://hooks.example.com/evil" });
    out.httpAfter = await call("agent", "monitor_get", { name: httpName });
    // A header's value changed and one removed: the undo says it keeps values, and still runs.
    out.headerChange = await put(httpName, { source: "http", service: "api", url: "https://api.example.com/health", every: "1m", headers: { Authorization: "Bearer two" }, webhook_url: "https://hooks.example.com/page" });
    out.headerUndo = await call("agent", out.headerChange.body.undo.tool, out.headerChange.body.undo.arguments);
    // (b) A pause alone by name pauses and keeps every other field; its undo is the pause it replaced.
    const pushName = "backup " + tag;
    out.push = await put(pushName, { source: "push", service: "backup", every: "1d", grace: "1h", webhook_url: "https://hooks.example.com/backup" });
    out.pushPause = await call("agent", "monitor_put", { name: pushName, body: { enabled: false } });
    out.pushAfterPause = await call("agent", "monitor_get", { name: pushName });
    out.pushUnpause = await call("agent", out.pushPause.body.undo.tool, out.pushPause.body.undo.arguments);
    out.pushAfterUnpause = await call("agent", "monitor_get", { name: pushName });
    // An empty body is no pause: a replace, previewed first.
    out.pushEmpty = await call("agent", "monitor_put", { name: pushName, body: {} });
    // A pause alone to no monitor is refused as the draft reads it.
    out.pauseNothing = await call("agent", "monitor_put", { name: "nothing " + tag, body: { enabled: false } });
    // 3. A replace's preview does not unlock a make of a second monitor of that name.
    out.createWithReplacePreview = await api("agent", "POST", "/api/alert-rules", { ...monitor, name });
    await call("agent", "monitor_draft_preview", { body: { ...monitor, name, saves: "create" } });
    out.createPreviewed = await api("agent", "POST", "/api/alert-rules", { ...monitor, name });
    await api("agent", "DELETE", "/api/alert-rules/" + out.createPreviewed.body.id);
    // 4. An undo is let through for 10 minutes, then needs a preview like any save.
    await call("agent", "monitor_draft_preview", { body: { ...monitor, threshold: 600, name: pushName + " search" } });
    const lateMade = await call("agent", "monitor_put", { name: pushName + " search", body: { ...monitor, threshold: 600 } });
    await call("agent", "monitor_draft_preview", { body: { ...monitor, threshold: 700, name: pushName + " search" } });
    out.lateChange = await call("agent", "monitor_put", { name: pushName + " search", body: { ...monitor, threshold: 700 } });
    setSystemTime(new Date(Date.now() + 11 * 60_000));
    out.lateUndo = await call("agent", out.lateChange.body.undo.tool, out.lateChange.body.undo.arguments);
    setSystemTime();
    void lateMade;

    // A browser session saves without a preview: the person is looking at the editor.
    const link = people.createOwnerLink("ian@example.test");
    const setup = await app.fetch(new Request("http://app.test/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: link.token, name: "Ian", password: "ian's long password" }) }));
    const cookie = setup.headers.get("set-cookie").split(";")[0];
    await (await import(root + "/control/owner-for-tests.ts")).passTwoStepSetup(app.fetch, cookie);
    out.session = await api("cookie:" + cookie, "PUT", "/api/monitors/" + encodeURIComponent("by hand " + tag), { ...monitor, threshold: 7 });
    // A session's change by id may not turn an HTTP(S) monitor into a TCP one either.
    out.sessionToTcp = await api("cookie:" + cookie, "PUT", "/api/alert-rules/" + out.http.body.id, { source: "tcp", target: "evil.example.com:443" });

    // Home: a canvas of two panels; the agent adds a third, and the first two stay where they were.
    const homeLayout = { logs: true, widgets: [
      { id: "a", kind: "timeseries", x: 0, y: 0, w: 12, h: 4, split: "level", chart: "stacked" },
      { id: "b", kind: "hbar", x: 0, y: 4, w: 6, h: 3, split: "service", n: 5 },
    ] };
    const home = await api("agent", "POST", "/api/saved-searches", { name: "home " + tag, query: "service:api", range: "1h", widgets: homeLayout });
    // Marked Home through MCP (#361), with the call that puts Home back.
    out.homeRead = await call("agent", "home", {});
    out.homeSet = await call("agent", "home_set", { body: { saved_id: home.body.id } });
    out.homeReadAfter = await call("agent", "home", {});
    out.homeBefore = (await api("agent", "GET", "/api/saved-searches")).body.searches.find((s) => s.id === home.body.id).widgets;
    out.panelPreview = await call("agent", "panel_preview", { id: "home", body: { kind: "stat", agg: "count" } });
    out.hbarPreview = await call("agent", "panel_preview", { id: "home", body: { kind: "hbar", split: "level", n: 3 } });
    out.panelAdd = await call("agent", "panel_add", { id: "home", body: { kind: "stat", agg: "count", w: 6, h: 2 } });
    out.panelMove = await call("agent", "panel_put", { id: "home", panel: out.panelAdd.body.id, body: { x: 0, y: 4 } });
    out.afterMove = (await api("agent", "GET", "/api/saved-searches")).body.searches.find((s) => s.id === home.body.id).widgets;
    out.undoMove = await call("agent", out.panelMove.body.undo.tool, out.panelMove.body.undo.arguments);
    out.undoAdd = await call("agent", out.panelAdd.body.undo.tool, out.panelAdd.body.undo.arguments);
    out.homeAfter = (await api("agent", "GET", "/api/saved-searches")).body.searches.find((s) => s.id === home.body.id).widgets;
    out.pinnedMove = await call("agent", "panel_put", { id: "home", panel: "a", body: { x: 3 } });
    out.homeUndo = await call("agent", out.homeSet.body.undo.tool, out.homeSet.body.undo.arguments);
    out.homeReadUndone = await call("agent", "home", {});
    await api("agent", "PUT", "/api/home", { saved_id: home.body.id });

    // A field's role, one at a time, and put back.
    const key = "design_" + tag;
    out.role = await call("agent", "field_role_set", { key, body: { role: "lookup" } });
    out.roles = (await api("agent", "GET", "/api/fields")).body.roles;
    out.undoRole = await call("agent", out.role.body.undo.tool, out.role.body.undo.arguments);
    out.rolesAfter = (await api("agent", "GET", "/api/fields")).body.roles;

    // A note on the clock, and taken off it.
    const at = new Date(now - 60_000).toISOString();
    out.note = await call("agent", "note_write", { body: { title: "rolled back checkout " + tag, ts: at, service: "api" } });
    const window = { from: new Date(now - 3_600_000).toISOString(), to: new Date(now + 60_000).toISOString() };
    out.marks = (await api("agent", "GET", "/api/marks?kind=note&from=" + window.from + "&to=" + window.to)).body;
    out.undoNote = await call("agent", out.note.body.undo.tool, out.note.body.undo.arguments);
    out.marksAfter = (await api("agent", "GET", "/api/marks?kind=note&from=" + window.from + "&to=" + window.to)).body;

    // A Viewer is refused every write, each in its route's own words, through MCP as straight at the route.
    const { mcpTools, toolCall } = await import(root + "/mcp/tools.ts");
    const writes = {
      saved_search_update: { id: savedId, body: { query: "x" } },
      saved_search_delete: { id: savedId },
      saved_search_test: { id: savedId },
      monitor_draft_preview: { body: { ...monitor, name } },
      monitor_send: { body: { url: "https://api.example.com" } },
      monitor_put: { name, body: monitor },
      monitor_delete: { name },
      panel_add: { id: "home", body: { kind: "stat" } },
      panel_put: { id: "home", panel: "b", body: { x: 6 } },
      panel_remove: { id: "home", panel: "b" },
      home_set: { body: { saved_id: null } },
      field_role_set: { key, body: { role: "ignore" } },
      note_write: { body: { title: "no" } },
      note_delete: { id: out.note.body.id },
    };
    out.viewer = {};
    for (const [tool, args] of Object.entries(writes)) {
      const via = await call("viewer", tool, args);
      const built = toolCall(mcpTools.find((t) => t.name === tool), args);
      const direct = await api("viewer", built.method, built.path, args.body);
      out.viewer[tool] = { via, direct };
    }
    // The monitor they could not delete is still there, and so is Home's panel b.
    out.stillThere = await call("agent", "monitor_get", { name });
    console.log(JSON.stringify(out));
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", script], {
    cwd: fixture,
    env: {
      ...process.env,
      CLICKHOUSE_USER: process.env.CLICKHOUSE_USER ?? "default",
      CLICKHOUSE_PASSWORD: process.env.CLICKHOUSE_PASSWORD ?? "toposcope",
      NODE_PATH: join(root, "../node_modules"),
      TOPOSCOPE_DEV: "1",
      SQLITE_PATH: ":memory:",
      OTLP_GRPC_PORT: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  r = JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!);
}, 120_000);

afterAll(() => rmSync(fixture, { recursive: true, force: true }));

const sentence = /call monitor_draft_preview \(POST \/api\/monitors\/preview\) with this same body and its (name|id) in it, then save it within 10 minutes/;

describe("design tools (#360)", () => {
  test("an Operator is offered every design tool; a preview reads only, a delete is marked", () => {
    const names = (r.list as Array<{ name: string }>).map((t) => t.name);
    for (const id of designToolRouteIds()) expect(names).toContain(id);
    const tool = (n: string) => r.list.find((t: { name: string }) => t.name === n);
    expect(tool("monitor_draft_preview").annotations).toEqual({ readOnlyHint: true });
    expect(tool("monitor_delete").annotations).toEqual({ destructiveHint: true });
    expect(tool("monitor_put").annotations).toBeUndefined();
  });

  test("a saved search's preview says what it finds; its save answers with its link and the delete that undoes it", () => {
    expect(r.searchPreview.isError).toBe(false);
    expect(r.searchPreview.body.rows).toBeGreaterThanOrEqual(0);
    expect(r.searchPreview.body.window.range).toBe("5m");
    expect(r.searchSaved.isError).toBe(false);
    expect(r.searchSaved.body.link).toStartWith("/?");
    expect(r.searchSaved.body.link).toContain("saved=" + r.searchSaved.body.id);
    expect(r.searchSaved.body.undo).toMatchObject({ tool: "saved_search_delete", arguments: { id: r.searchSaved.body.id } });
  });

  test("from tools alone: a monitor on service:api level:error is previewed, saved, listed, and undone with the call it was given", () => {
    const bar = Date.parse(r.bar);
    expect(r.preview.isError).toBe(false);
    expect(r.preview.body.days).toBe(7);
    expect(r.preview.body.window).toBe("5m");
    expect(r.preview.body.previewed).toBe(true);
    // The seeded burst's bar opens it, and a later bar resolves it.
    const covering = r.preview.body.stretches.find((s: { opened: string; resolved: string | null }) => Date.parse(s.opened) <= bar && (s.resolved === null || Date.parse(s.resolved) > bar));
    expect(covering).toBeDefined();
    expect(r.preview.body.hourly.length).toBeGreaterThan(100);
    expect(Date.parse(r.preview.body.saves_until)).toBeGreaterThan(Date.now());

    expect(r.saved.isError).toBe(false);
    // Design tools come back fenced like every tool, so a saved name an agent did not write reads as data.
    expect(r.saved.fenced).toBe(true);
    expect(r.saved.body.name).toBe(r.preview.body.name);
    expect(r.saved.body.link).toBe("/?view=watch");
    expect(r.saved.body.undo).toMatchObject({ tool: "monitor_delete", arguments: { name: r.preview.body.name } });
    const listed = r.listed.body.monitors.find((m: { name: string }) => m.name === r.preview.body.name);
    expect(listed.made_by.name).toBe("agent");
    expect(listed.query).toBe("service:api level:error");
    expect(r.undoMade.isError).toBe(false);
    expect(r.goneAfterUndo.body).toEqual({ error: "Monitor not found" });
  });

  test("a save without a preview is refused, with the sentence that names the tool and the call to make", () => {
    expect(r.unpreviewed.isError).toBe(true);
    expect(r.unpreviewed.body.error).toStartWith("A monitor saved with a token is previewed first: ");
    expect(r.unpreviewed.body.error).toMatch(sentence);
    expect(r.unpreviewed.body.preview.tool).toBe("monitor_draft_preview");
    expect(r.unpreviewed.body.preview.arguments.body.name).toBe(r.preview.body.name);
  });

  test("a body changed after its preview, and a preview older than 10 minutes, are refused", () => {
    expect(r.changed.isError).toBe(true);
    expect(r.changed.body.error).toStartWith("This body is not the one previewed: it changed since.");
    expect(r.changed.body.error).toMatch(sentence);
    expect(r.stale.isError).toBe(true);
    expect(r.stale.body.error).toStartWith("This monitor's preview is more than 10 minutes old: ");
  });

  test("a change answers with the body it replaced, and that undo is let through without a preview", () => {
    expect(r.again.isError).toBe(false);
    expect(r.change.isError).toBe(false);
    expect(r.change.body.threshold).toBe(500);
    expect(r.change.body.undo.tool).toBe("monitor_put");
    expect(r.change.body.undo.arguments.body).toMatchObject({ source: "search", threshold: 300, service: "api", saved_search_id: r.searchSaved.body.id });
    expect(r.undoChange.isError).toBe(false);
    expect(r.afterUndoChange.body.threshold).toBe(300);
    expect(r.afterUndoChange.body.webhook_urls).toEqual(["https://hooks.example.com/page"]);
  });

  test("a pause needs no preview; a change by id is held, and its preview names the id", () => {
    expect(r.pause.status).toBe(200);
    expect(r.byIdUnpreviewed.status).toBe(428);
    expect(r.byIdUnpreviewed.body.error).toContain("with this same body and its id in it");
    expect(r.byIdPreview.isError).toBe(false);
    expect(r.byIdPreview.body.threshold).toBe(400);
    expect(r.byIdSaved.status).toBe(200);
    expect(r.byIdSaved.body.threshold).toBe(400);
  });

  test("every kind previews: a share and fewer than draw, the rest say why they cannot", () => {
    expect(r.kinds.share.body.measure).toBe("share");
    expect(r.kinds.share.body.cannot).toBeNull();
    expect(r.kinds.fewer.body.opens_when).toBe("fewer_than");
    expect(r.kinds.fewer.body.cannot).toBeNull();
    for (const kind of ["fingerprints", "push", "http", "tcp", "cert"]) {
      expect({ kind, isError: r.kinds[kind].isError, previewed: r.kinds[kind].body.previewed }).toEqual({ kind, isError: false, previewed: false });
      expect(typeof r.kinds[kind].body.cannot).toBe("string");
    }
    expect(r.kinds.http.body.cannot).toContain("monitor_send");
    expect(r.kinds.push.body.cannot).toContain("late");
    // A body the save refuses is refused by its preview, in the save's words.
    expect(r.badPreview.isError).toBe(true);
    expect(r.badPreview.body.error).toBe("remind_every must be off, window, 1h, 4h or 24h");
  });

  test("a browser session saves a monitor with no preview", () => {
    expect(r.session.status).toBe(201);
  });

  test("a panel added to Home leaves the panels there where they were; a move is undone by the canvas it was", () => {
    const before = r.homeBefore.widgets;
    expect(before.map((w: { id: string }) => w.id)).toEqual(["a", "b"]);
    expect(r.panelPreview.isError).toBe(false);
    expect(r.panelPreview.body.lines[0].reads).toBe("count");
    expect(Array.isArray(r.panelPreview.body.lines[0].bars)).toBe(true);
    expect(Array.isArray(r.hbarPreview.body.top)).toBe(true);
    expect(r.panelAdd.isError).toBe(false);
    expect(r.panelAdd.body.id).toBe("c");
    expect(r.panelAdd.body.panels.map((w: { id: string }) => w.id)).toEqual(["a", "b", "c"]);
    for (const w of before) {
      expect(r.panelAdd.body.panels.find((p: { id: string }) => p.id === w.id)).toMatchObject({ x: w.x, y: w.y, w: w.w, h: w.h });
    }
    expect(r.panelAdd.body.undo).toMatchObject({ tool: "panel_remove", arguments: { panel: "c" } });
    // Moved onto b: b moves down, and is still there.
    expect(r.afterMove.widgets.map((w: { id: string }) => w.id)).toEqual(["a", "b", "c"]);
    expect(r.panelMove.body.undo.tool).toBe("saved_search_update");
    expect(r.undoMove.isError).toBe(false);
    expect(r.undoAdd.isError).toBe(false);
    expect(r.homeAfter).toEqual(r.homeBefore);
    expect(r.pinnedMove.isError).toBe(true);
  });

  test("Home is read and marked through MCP, and the mark is undone by the call it answered with (#361)", () => {
    expect(r.homeRead.body).toEqual({ saved_id: null });
    expect(r.homeSet.isError).toBe(false);
    expect(r.homeSet.body).toMatchObject({ saved_id: r.homeReadAfter.body.saved_id, link: "/?view=home" });
    expect(r.homeSet.body.undo).toEqual({ tool: "home_set", arguments: { body: { saved_id: null } }, does: "Unmarks Home, as it was before" });
    expect(r.homeReadAfter.body.saved_id).not.toBeNull();
    expect(r.homeUndo.isError).toBe(false);
    expect(r.homeReadUndone.body).toEqual({ saved_id: null });
  });

  test("a field's role is set alone, and put back", () => {
    const key = r.role.body.key;
    expect(r.role.body).toMatchObject({ role: "lookup", was: "chart", link: "/?view=fields" });
    expect(r.roles[key]).toBe("lookup");
    expect(r.role.body.undo).toEqual({ tool: "field_role_set", arguments: { key, body: { role: "chart" } }, does: `Gives ${key} back its role chart` });
    expect(r.undoRole.isError).toBe(false);
    expect(r.rolesAfter[key]).toBeUndefined();
  });

  test("a note is written on the clock under the agent's name, and its undo takes it off", () => {
    expect(r.note.isError).toBe(false);
    expect(r.note.body.mark.attrs.by).toBe("agent");
    expect(r.note.body.undo).toMatchObject({ tool: "note_delete", arguments: { id: r.note.body.id } });
    const ids = (marks: { marks?: Array<{ id: string }> }) => (marks.marks ?? []).map((m) => m.id);
    expect(ids(r.marks)).toContain(r.note.body.id);
    expect(r.undoNote.isError).toBe(false);
    expect(ids(r.marksAfter)).not.toContain(r.note.body.id);
  });

  test("a Viewer is refused every write, in the route's own sentence", () => {
    for (const [tool, { via, direct }] of Object.entries(r.viewer as Record<string, { via: { isError: boolean; body: any }; direct: Answer }>)) {
      expect({ tool, isError: via.isError, status: direct.status }).toEqual({ tool, isError: true, status: 403 });
      expect({ tool, body: via.body }).toEqual({ tool, body: direct.body });
      const route = apiRoutes.find((x) => x.id === tool)!;
      if (roleOf(route) !== "viewer") {
        expect({ tool, error: via.body.error }).toEqual({ tool, error: refusalWords("viewer", route.action) });
      }
    }
    // The routes a Viewer may call for their own hunts refuse someone else's in their own words.
    expect(r.viewer.panel_add.via.body.error).toBe("A Viewer may change only their own hunts: ask an Operator");
    expect(r.viewer.saved_search_delete.via.body.error).toBe("Only whoever saved this hunt, or an Owner, may delete it");
    expect(r.stillThere.isError).toBe(false);
  });
});

describe("the security review's cases (#360)", () => {
  test("(a) a body the draft refuses is refused by the gate in its words: an HTTP(S) monitor does not become TCP", () => {
    expect(r.http.isError).toBe(false);
    expect(r.toTcp.status).toBe(400);
    expect(r.toTcp.body.error).toContain("is an HTTP(S) monitor; delete it to make a TCP monitor of that name");
    expect(r.httpAfter.body.source).toBe("http");
    expect(r.httpAfter.body.http.url).toBe("https://api.example.com/health");
    expect(r.sessionToTcp.status).toBe(400);
    expect(r.sessionToTcp.body.error).toContain("delete it to make a TCP monitor");
  });

  test("(b) a pause alone by name keeps every other field, and is undone by the pause it replaced", () => {
    expect(r.pushPause.isError).toBe(false);
    expect(r.pushAfterPause.body.enabled).toBe(0);
    expect(r.pushAfterPause.body.every_ms).toBe(86_400_000);
    expect(r.pushAfterPause.body.grace_ms).toBe(3_600_000);
    expect(r.pushAfterPause.body.webhook_url).toBe("https://hooks.example.com/backup");
    expect(r.pushPause.body.undo).toMatchObject({ tool: "monitor_put", arguments: { body: { enabled: true } } });
    expect(r.pushUnpause.isError).toBe(false);
    expect(r.pushAfterUnpause.body.enabled).toBe(1);
    expect(r.pushAfterUnpause.body.every_ms).toBe(86_400_000);
    expect(r.pushEmpty.isError).toBe(true);
    expect(r.pushEmpty.body.error).toMatch(sentence);
    expect(r.pauseNothing.isError).toBe(true);
    expect(r.pauseNothing.body.error).toBe("source is required: search, fingerprints, push, http, tcp or cert");
  });

  test("a replace's preview does not unlock a make of a second monitor of that name", () => {
    expect(r.createWithReplacePreview.status).toBe(428);
    expect(r.createWithReplacePreview.body.error).toContain('its name and saves: "create" in it');
    expect(r.createWithReplacePreview.body.preview.arguments.body.saves).toBe("create");
    expect(r.createPreviewed.status).toBe(201);
  });

  test("an undo is let through for 10 minutes only", () => {
    expect(r.lateChange.isError).toBe(false);
    expect(r.lateUndo.isError).toBe(true);
    expect(r.lateUndo.body.error).toStartWith("A monitor saved with a token is previewed first");
  });

  test("an HTTP(S) monitor's undo says it keeps header values, keeps only headers still stored, and runs", () => {
    expect(r.headerChange.isError).toBe(false);
    expect(r.headerChange.body.undo.does).toContain("Header values are not shown, so this undo keeps their current values; set them again by hand");
    expect(r.headerChange.body.undo.arguments.body.headers).toEqual([["Authorization", null]]);
    expect(r.headerUndo.isError).toBe(false);
    expect(r.headerUndo.body.http.headers).toEqual(["Authorization"]);
  });
});

describe("the preview's hash", () => {
  test("key order, spaces around text, and the hold keys are not a change; anything else is", () => {
    const a = bodyHash({ threshold: 5, service: "api", source: "search" }, { name: "x", saves: "replace" });
    expect(bodyHash({ source: "search", service: " api ", threshold: 5, enabled: false }, { name: " x ", saves: "replace" })).toBe(a);
    expect(bodyHash({ threshold: 6, service: "api", source: "search" }, { name: "x", saves: "replace" })).not.toBe(a);
    expect(bodyHash({ threshold: 5, service: "api", source: "search" }, { name: "y", saves: "replace" })).not.toBe(a);
    expect(bodyHash({ threshold: 5, service: "api", source: "search" }, { id: "x" })).not.toBe(a);
    // A make's preview is not a replace's.
    expect(bodyHash({ threshold: 5, service: "api", source: "search" }, { name: "x", saves: "create" })).not.toBe(a);
    expect(monitorDraft({ name: "old", id: "1", threshold: 1 }, { id: "1" })).toEqual({ name: "old", id: "1", threshold: 1 });
  });
});
