import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeNext, signInPageHtml } from "./sign-in-page";
import { parseInstanceName } from "./control/instance";

const root = import.meta.dir;
const fixture = mkdtempSync(join(tmpdir(), "toposcope-sign-in-"));
type R = { status: number; type: string | null; challenge: string | null; cookie: string | null; location: string | null; body: string; ms?: number };
let r: Record<string, R>;

beforeAll(async () => {
  await Bun.write(join(fixture, "src/ui/dist/index.html"), "<!doctype html><html>the app</html>");
  // The real app, routing and SQLite, in a child: ClickHouse and the timers are stubbed.
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
    const page = { accept: "text/html,application/xhtml+xml" };
    const basic = { authorization: "Basic " + btoa("anyone:pw-one") };
    const go = async (key, path, init = {}) => {
      const t = Date.now();
      const res = await app.fetch(new Request("http://app.test" + path, { redirect: "manual", ...init }));
      out[key] = { status: res.status, type: res.headers.get("content-type"), challenge: res.headers.get("www-authenticate"), cookie: res.headers.get("set-cookie"), location: res.headers.get("location"), body: await res.text(), ms: Date.now() - t };
      return out[key];
    };
    const form = (password, next = "/") => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", host: "logs.example.test" }, body: new URLSearchParams({ password, next }).toString() });
    await go("pageUnnamed", "/?q=level:error", { headers: { ...page, host: "127.0.0.1:18080" } });
    await go("apiBare", "/api/saved-searches");
    await go("basic", "/api/saved-searches", { headers: basic });
    await go("rename", "/api/settings", { method: "PUT", headers: { ...basic, "content-type": "application/json" }, body: JSON.stringify({ instance_name: "  agental-prod " }) });
    await go("pageNamed", "/", { headers: { ...page, host: "logs.example.test" } });
    await go("realm", "/api/saved-searches");
    await go("wrong", "/api/sign-in", form("nope", "/?q=x"));
    const ok = await go("right", "/api/sign-in", form("pw-one", "/?q=level:error"));
    await go("offsite", "/api/sign-in", form("pw-one", "//evil.example/"));
    const cookie = ok.cookie.split(";")[0];
    await go("withCookie", "/api/saved-searches", { headers: { cookie } });
    await go("instance", "/api/instance", { headers: { cookie, host: "logs.example.test" } });
    await go("appPage", "/", { headers: { ...page, cookie } });
    await go("badCookie", "/api/saved-searches", { headers: { cookie: cookie.slice(0, -3) + "AAA" } });
    process.env.TOPOSCOPE_PASSWORD = "pw-two";
    await go("afterPasswordChange", "/api/saved-searches", { headers: { cookie } });
    await go("pageAfterChange", "/", { headers: { ...page, cookie } });
    process.env.TOPOSCOPE_PASSWORD = "pw-one";
    await go("passwordBack", "/api/saved-searches", { headers: { cookie } });
    await go("signOut", "/api/sign-out", { method: "POST", headers: { cookie } });
    await go("afterSignOut", "/api/saved-searches", { headers: { cookie } });
    await go("signedOutPage", "/?signed_out=1", { headers: { ...page, host: "logs.example.test" } });
    await go("ingestStill", "/api/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    console.log(JSON.stringify(out));
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", script], {
    cwd: fixture,
    env: {
      ...process.env,
      NODE_PATH: join(root, "../node_modules"),
      TOPOSCOPE_DEV: "1",
      TOPOSCOPE_PASSWORD: "pw-one",
      TOPOSCOPE_INGEST_TOKEN: "ingest-only",
      SQLITE_PATH: ":memory:",
      CLICKHOUSE_URL: "http://clickhouse.test",
      OTLP_GRPC_PORT: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  r = JSON.parse(child.stdout.toString());
});

afterAll(() => rmSync(fixture, { recursive: true, force: true }));

describe("signing in from a browser that shows no Basic prompt (#102)", () => {
  test("a page asked for without the password is the sign-in page, not the challenge", () => {
    expect(r.pageUnnamed!.status).toBe(401);
    expect(r.pageUnnamed!.type).toContain("text/html");
    expect(r.pageUnnamed!.challenge).toBeNull();
    expect(r.pageUnnamed!.body).toContain("Signing in to");
    expect(r.pageUnnamed!.body).toContain("<h1 class=\"mono\">127.0.0.1:18080</h1>");
    expect(r.pageUnnamed!.body).toContain("This instance has no name yet.");
    expect(r.pageUnnamed!.body).toContain('name="next" value="/?q=level:error"');
  });

  test("an API call without credentials keeps today's answer, with the realm naming the instance", () => {
    expect(r.apiBare!.status).toBe(401);
    expect(r.apiBare!.challenge).toBe('Basic realm="toposcope"');
    expect(r.basic!.status).toBe(200);
    expect(r.rename!.status).toBe(200);
    expect(JSON.parse(r.rename!.body).instance_name).toBe("agental-prod");
    expect(r.realm!.challenge).toBe('Basic realm="toposcope · agental-prod"');
  });

  test("the page names the instance once it has a name", () => {
    expect(r.pageNamed!.body).toContain("<title>Sign in · agental-prod</title>");
    expect(r.pageNamed!.body).toContain("<h1>agental-prod</h1><div class=\"addr\">logs.example.test</div>");
  });

  test("a wrong password is answered after a pause, on the page", () => {
    expect(r.wrong!.status).toBe(401);
    expect(r.wrong!.ms!).toBeGreaterThanOrEqual(700);
    expect(r.wrong!.body).toContain("That is not the password for agental-prod.");
    expect(r.wrong!.body).toContain('aria-invalid="true"');
    expect(r.wrong!.cookie).toBeNull();
  });

  test("the right one sets a 30-day cookie and goes back where it was", () => {
    expect(r.right!.status).toBe(303);
    expect(r.right!.location).toBe("/?q=level:error");
    expect(r.right!.cookie).toMatch(/^toposcope_session_[0-9a-f]{8}=[^;]+; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Strict$/);
    expect(r.offsite!.location).toBe("/");
    expect(r.withCookie!.status).toBe(200);
    expect(r.appPage!.status).toBe(200);
    expect(r.appPage!.body).toContain("the app");
    const info = JSON.parse(r.instance!.body);
    expect(info.name).toBe("agental-prod");
    expect(info.address).toBe("logs.example.test");
    expect(info.session.kind).toBe("cookie");
    expect(info.session.expires_at).toBeGreaterThan(Date.now() + 29 * 24 * 3600_000);
  });

  test("a request with a cookie that no longer works is never answered with the challenge", () => {
    expect(r.badCookie!.status).toBe(401);
    expect(r.badCookie!.challenge).toBeNull();
  });

  test("a changed password signs every browser out", () => {
    expect(r.afterPasswordChange!.status).toBe(401);
    expect(r.pageAfterChange!.body).toContain("Signing in to");
    expect(r.passwordBack!.status).toBe(200);
  });

  test("Sign out ends it on this browser and says so", () => {
    expect(r.signOut!.status).toBe(200);
    expect(r.signOut!.cookie).toContain("Max-Age=0");
    expect(r.afterSignOut!.status).toBe(401);
    expect(r.signedOutPage!.body).toContain("Signed out of agental-prod on this browser.");
    expect(r.signedOutPage!.body).toContain('name="next" value="/"');
  });

  test("ingest still wants its token", () => {
    expect(r.ingestStill!.status).toBe(401);
  });
});

describe("the sign-in page and the name", () => {
  test("next stays on this instance", () => {
    expect(safeNext("/?q=a")).toBe("/?q=a");
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("https://evil.example")).toBe("/");
    expect(safeNext("/\\evil")).toBe("/");
  });
  test("a name and an address are escaped", () => {
    const html = signInPageHtml({ name: '<b>"x"</b>', address: "a&b", next: "/" });
    expect(html).toContain("&lt;b&gt;&quot;x&quot;&lt;/b&gt;");
    expect(html).toContain("a&amp;b");
  });
  test("a name is trimmed, at most 64 characters, and empty unsets it", () => {
    expect(parseInstanceName("  agental   prod ")).toBe("agental prod");
    expect(parseInstanceName("")).toBeNull();
    expect(parseInstanceName("x".repeat(65))).toEqual({ error: "The instance name is at most 64 characters" });
    expect(parseInstanceName("a\u0007b")).toEqual({ error: "The instance name cannot hold control characters" });
  });
});
