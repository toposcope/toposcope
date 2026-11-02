import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = import.meta.dir;
const fixture = mkdtempSync(join(tmpdir(), "toposcope-github-"));
type R = { status: number; body: any };
let r: Record<string, R>;
let seen: string[];

beforeAll(async () => {
  await Bun.write(join(fixture, "src/ui/dist/index.html"), "<!doctype html><html>the app</html>");
  const script = `
    import { mock } from "bun:test";
    const root = ${JSON.stringify(root)};
    const migrate = await import(root + "/shared/migrate.ts");
    mock.module(root + "/shared/migrate.ts", () => ({ ...migrate, migrateStore: async () => {}, syncFieldRoleSkip: async () => {} }));
    mock.module(root + "/alerts/cron.ts", () => ({ startAlertCron() {} }));
    mock.module(root + "/ingest/syslog.ts", () => ({ startSyslogUdp: async () => {} }));
    // GitHub: a device code with no wait, then "not yet" and a token by turns; honzabit installed the App
    // on acme (two repositories) and on honzabit (one private). While revoked, GitHub refuses the token.
    const seen = [];
    let polls = 0;
    let revoked = false;
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.endsWith("/ping")) return new Response("Ok.");
      if (u.startsWith("http://clickhouse.test")) return Response.json({ data: [] });
      if (u.startsWith("https://github.com/") || u.startsWith("https://api.github.com/")) {
        seen.push((init?.method ?? "GET") + " " + u + (init?.headers?.authorization ? " " + init.headers.authorization : "") + (init?.body ? " " + init.body : ""));
        if (u === "https://github.com/login/device/code") return Response.json({ device_code: "dc-1", user_code: "WDJB-MJHT", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 0 });
        if (u === "https://github.com/login/oauth/access_token") return Response.json(++polls % 2 === 1 ? { error: "authorization_pending" } : { access_token: "gho_first", token_type: "bearer", scope: "" });
        const auth = init?.headers?.authorization;
        if (revoked) return new Response("{}", { status: 401 });
        if (u === "https://api.github.com/user") return Response.json({ login: "honzabit" });
        if (u.startsWith("https://api.github.com/user/installations?")) return Response.json({ installations: [{ id: 1, account: { login: "acme" } }, { id: 2, account: { login: "honzabit" } }] });
        const repo = (full, priv = false) => ({ full_name: full, html_url: "https://github.com/" + full, private: priv, owner: { login: full.split("/")[0] } });
        if (u.startsWith("https://api.github.com/user/installations/1/repositories")) return Response.json({ total_count: 2, repositories: [repo("acme/platform-infra"), repo("acme/api")] });
        if (u.startsWith("https://api.github.com/user/installations/2/repositories")) return Response.json({ total_count: 1, repositories: [repo("honzabit/platform-lab", true)] });
        return new Response("{}", { status: 404 });
      }
      throw new Error("Unexpected external fetch " + u);
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
    const tokens = { owner: bearer("maya", "owner"), operator: bearer("ops-bot", "operator"), viewer: bearer("reader", "viewer") };
    const out = {};
    const go = async (key, path, method = "GET", as = "owner") => {
      const res = await app.fetch(new Request("http://app.test" + path, { method, headers: { authorization: tokens[as] } }));
      const text = await res.text();
      out[key] = { status: res.status, body: text.startsWith("{") ? JSON.parse(text) : text };
    };
    await go("off", "/api/github", "GET", "viewer");
    await go("operatorConnect", "/api/github/connect", "POST", "operator");
    await go("connect", "/api/github/connect", "POST");
    await go("on", "/api/github", "GET", "viewer");
    await go("all", "/api/github/repositories", "GET", "operator");
    await go("search", "/api/github/repositories?q=PLATFORM", "GET", "operator");
    await go("viewerList", "/api/github/repositories", "GET", "viewer");
    await go("viewerDisconnect", "/api/github", "DELETE", "viewer");
    revoked = true;
    await go("revokedPoll", "/api/github?fresh=1");
    await go("ended", "/api/github");
    revoked = false;
    await go("cancelStart", "/api/github/connect", "POST");
    await go("cancel", "/api/github/connect", "DELETE");
    await go("connectAgain", "/api/github/connect", "POST");
    await go("onAgain", "/api/github");
    await go("disconnect", "/api/github", "DELETE");
    await go("afterDisconnect", "/api/github/repositories", "GET", "operator");
    console.log(JSON.stringify({ out, seen }));
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", script], {
    cwd: fixture,
    env: { ...process.env, NODE_PATH: join(root, "../node_modules"), TOPOSCOPE_DEV: "1", TOPOSCOPE_INGEST_TOKEN: "ingest-only", SQLITE_PATH: ":memory:", CLICKHOUSE_URL: "http://clickhouse.test", OTLP_GRPC_PORT: "0", TOPOSCOPE_GITHUB_CLIENT_ID: "Iv23test" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  const parsed = JSON.parse(child.stdout.toString().trim().split("\n").pop()!);
  r = parsed.out;
  seen = parsed.seen;
});

afterAll(() => rmSync(fixture, { recursive: true, force: true }));

describe("Connect GitHub (#416)", () => {
  test("not connected, and only an Owner connects (42a)", () => {
    expect(r.off!.body).toEqual({ configured: true, state: "off", install_url: "https://github.com/apps/toposcope/installations/new" });
    expect(r.operatorConnect!.status).toBe(403);
    expect(r.viewerDisconnect!.status).toBe(403);
  });

  test("the device code waits, then the token arrives on a later read (42b, 42d)", () => {
    expect(r.connect!.status).toBe(200);
    expect(r.connect!.body.state).toBe("connecting");
    expect(r.connect!.body.code).toMatchObject({ user_code: "WDJB-MJHT", verification_uri: "https://github.com/login/device" });
    expect(r.on!.body).toMatchObject({ state: "on", login: "honzabit", accounts: ["acme", "honzabit"], repositories: 3 });
    expect(r.on!.body.connected_by.name).toBe("maya");
    expect(seen.some((s) => s.includes("/login/device/code") && s.includes("client_id=Iv23test"))).toBe(true);
  });

  test("the token never reaches a browser", () => {
    for (const key of ["connect", "on", "all", "search", "disconnect", "ended"]) {
      expect(JSON.stringify(r[key]!.body)).not.toContain("gho_");
    }
  });

  test("Set lists the App's repositories, matching q (42e)", () => {
    expect(r.all!.body.total).toBe(3);
    expect(r.all!.body.repositories.map((x: { name: string }) => x.name)).toEqual(["acme/api", "acme/platform-infra", "honzabit/platform-lab"]);
    expect(r.search!.body).toMatchObject({ matching: 2, total: 3 });
    expect(r.search!.body.repositories[1]).toEqual({ url: "https://github.com/honzabit/platform-lab", name: "honzabit/platform-lab", owner: "honzabit", private: true });
    expect(r.viewerList!.status).toBe(403);
  });

  test("disconnecting forgets the token (42f)", () => {
    expect(r.disconnect!.body.state).toBe("off");
    expect(r.afterDisconnect!.body).toEqual({ repositories: [], matching: 0, total: 0 });
  });

  test("a token GitHub refuses ends the connection (42h)", () => {
    expect(r.revokedPoll!.body.state).toBe("ended");
    expect(r.ended!.body.state).toBe("ended");
    expect(r.ended!.body.login).toBe("honzabit");
    expect(typeof r.ended!.body.ended_at).toBe("number");
  });

  test("cancel stops waiting for the code; Connect again connects", () => {
    expect(r.cancelStart!.body.state).toBe("connecting");
    expect(r.cancel!.body.state).toBe("ended");
    expect(r.onAgain!.body).toMatchObject({ state: "on", repositories: 3 });
  });
});
