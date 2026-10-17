import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSearchUrl, savedSearchUrl } from "./ui/search-url";
import { workspaceLiveLabel } from "./ui/workspaces";

const root = import.meta.dir;
const fixture = mkdtempSync(join(tmpdir(), "toposcope-home-"));
type R = { status: number; location: string | null; body: string };
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
    const auth = { authorization: "Basic " + btoa("op:pw"), "content-type": "application/json", accept: "text/html" };
    const go = async (key, path, init = {}) => {
      const res = await app.fetch(new Request("http://app.test" + path, { redirect: "manual", headers: auth, ...init }));
      out[key] = { status: res.status, location: res.headers.get("location"), body: await res.text() };
      return out[key];
    };
    const made = await go("save", "/api/saved-searches", { method: "POST", body: JSON.stringify({ name: "noise off", query: '-preauth -"invalid user"', range: "1h" }) });
    const id = JSON.parse(made.body).id;
    const board = await go("saveBoard", "/api/saved-searches", { method: "POST", body: JSON.stringify({ name: "fleet · box", query: "service:box", range: "1h", board: { keys: ["host"], win: false } }) });
    const boardId = JSON.parse(board.body).id;
    await go("bareNone", "/");
    await go("setHome", "/api/home", { method: "PUT", body: JSON.stringify({ saved_id: id }) });
    await go("getHome", "/api/home");
    await go("bare", "/");
    await go("shared", "/?q=level:error&range=1h");
    await go("cleared", "/?range=1h&saved=" + id);
    await go("boardHome", "/api/home", { method: "PUT", body: JSON.stringify({ saved_id: boardId }) });
    await go("unset", "/api/home", { method: "PUT", body: JSON.stringify({ saved_id: null }) });
    await go("bareAfterUnset", "/");
    await go("setAgain", "/api/home", { method: "PUT", body: JSON.stringify({ saved_id: id }) });
    await go("deleteHome", "/api/saved-searches/" + id, { method: "DELETE" });
    await go("homeAfterDelete", "/api/home");
    await go("bareAfterDelete", "/");
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

describe("a Home saved search (#109)", () => {
  test("with no Home the bare address opens as today", () => {
    expect(r.bareNone!.status).toBe(200);
    expect(r.bareNone!.body).toContain("the app");
  });

  test("the bare address opens on Home, at its own URL", () => {
    expect(r.setHome!.status).toBe(200);
    expect(JSON.parse(r.getHome!.body).saved_id).toBe(JSON.parse(r.save!.body).id);
    expect(r.bare!.status).toBe(302);
    const state = parseSearchUrl(new URL(r.bare!.location!, "http://app.test").search);
    expect(state.q).toBe('-preauth -"invalid user"');
    expect(state.range).toBe("1h");
    expect(state.saved).toBe(JSON.parse(r.save!.body).id);
  });

  test("a link with its own q, and × to every row, open as they say", () => {
    expect(r.shared!.status).toBe(200);
    expect(r.cleared!.status).toBe(200);
  });

  test("a board cannot be Home", () => {
    expect(r.boardHome!.status).toBe(400);
    expect(JSON.parse(r.boardHome!.body).error).toBe("A board cannot be Home: it opens with its inputs unset.");
  });

  test("unmarking Home, or deleting it, brings back All logs", () => {
    expect(JSON.parse(r.unset!.body).saved_id).toBeNull();
    expect(r.bareAfterUnset!.status).toBe(200);
    expect(r.deleteHome!.status).toBe(200);
    expect(JSON.parse(r.homeAfterDelete!.body).saved_id).toBeNull();
    expect(r.bareAfterDelete!.status).toBe(200);
  });
});

describe("Home's URL and tab", () => {
  test("a saved search's URL carries its q, window, series, columns and id", () => {
    const url = savedSearchUrl({ id: "s1", query: "service:api", range: "4h", from_ts: null, to_ts: null, agg: "p99:duration_ms", cols: ["path", "status"] });
    const state = parseSearchUrl(url);
    expect(state).toMatchObject({ q: "service:api", range: "4h", saved: "s1", agg: "p99:duration_ms", cols: ["path", "status"] });
    const custom = parseSearchUrl(savedSearchUrl({ id: "s2", query: "", range: null, from_ts: "2026-10-16T12:00:00.000Z", to_ts: "2026-10-16T13:00:00.000Z" }));
    expect(custom.range).toBe("custom");
  });

  test("a Home tab keeps its name when edited (12j); another saved tab shows its q", () => {
    const base = { kind: "search" as const, q: "", savedName: "noise off", savedDirty: true, follow: null, surrAnchor: null };
    expect(workspaceLiveLabel({ ...base, home: true })).toBe("noise off · edited");
    expect(workspaceLiveLabel({ ...base, home: false })).toBe("All logs");
    expect(workspaceLiveLabel({ ...base, savedDirty: false, home: true })).toBe("noise off");
  });
});
