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
    const people = await import(root + "/control/people.ts");
    const page = { accept: "text/html,application/xhtml+xml" };
    const go = async (key, path, init = {}) => {
      const t = Date.now();
      const res = await app.fetch(new Request("http://app.test" + path, { redirect: "manual", ...init }));
      out[key] = { status: res.status, type: res.headers.get("content-type"), challenge: res.headers.get("www-authenticate"), cookie: res.headers.get("set-cookie"), location: res.headers.get("location"), body: await res.text(), ms: Date.now() - t };
      return out[key];
    };
    const urlenc = { "content-type": "application/x-www-form-urlencoded", host: "logs.example.test" };
    const form = (email, password, next = "/") => ({ method: "POST", headers: urlenc, body: new URLSearchParams({ email, password, next }).toString() });
    const setup = (token, name, password) => ({ method: "POST", headers: urlenc, body: new URLSearchParams({ token, name, password }).toString() });
    await go("pageNoOwner", "/?q=level:error", { headers: { ...page, host: "127.0.0.1:18080" } });
    await go("apiBare", "/api/saved-searches");
    await go("basic", "/api/saved-searches", { headers: { authorization: "Basic " + btoa("anyone:pw-one") } });
    // The host command (toposcope.sh owner-link) makes the link; nothing else does.
    const link = people.createOwnerLink("Ian@Agental.io");
    out.linkMakes = link.makes;
    await go("setupPage", "/setup/" + link.token, { headers: page });
    await go("setupShort", "/api/setup", setup(link.token, "Ian", "short"));
    const made = await go("setupDone", "/api/setup", setup(link.token, "Ian", "correct horse battery"));
    await go("setupAgain", "/setup/" + link.token, { headers: page });
    await go("setupReuse", "/api/setup", setup(link.token, "Ian", "correct horse battery"));
    const first = made.cookie.split(";")[0];
    await go("rename", "/api/settings", { method: "PUT", headers: { cookie: first, "content-type": "application/json" }, body: JSON.stringify({ instance_name: "  agental-prod " }) });
    await go("me", "/api/me", { headers: { cookie: first } });
    await go("pageNamed", "/", { headers: { ...page, host: "logs.example.test" } });
    await go("wrong", "/api/sign-in", form("ian@agental.io", "nope nope nope", "/?q=x"));
    await go("noSuchEmail", "/api/sign-in", form("who@agental.io", "correct horse battery"));
    const ok = await go("right", "/api/sign-in", form("IAN@agental.io", "correct horse battery", "/?q=level:error"));
    await go("offsite", "/api/sign-in", form("ian@agental.io", "correct horse battery", "//evil.example/"));
    const cookie = ok.cookie.split(";")[0];
    await go("withCookie", "/api/saved-searches", { headers: { cookie } });
    await go("instance", "/api/instance", { headers: { cookie, host: "logs.example.test" } });
    await go("appPage", "/", { headers: { ...page, cookie } });
    await go("badCookie", "/api/saved-searches", { headers: { cookie: cookie.slice(0, -3) + "AAA" } });
    // owner-link again for the same Owner is the way back in: a new password, and their sessions end.
    const back = people.createOwnerLink("ian@agental.io");
    out.backMakes = back.makes;
    await go("resetPage", "/setup/" + back.token, { headers: page });
    const reset = await go("reset", "/api/setup", setup(back.token, "", "a brand new password"));
    await go("afterReset", "/api/saved-searches", { headers: { cookie } });
    await go("oldPassword", "/api/sign-in", form("ian@agental.io", "correct horse battery"));
    const now = reset.cookie.split(";")[0];
    await go("newCookie", "/api/saved-searches", { headers: { cookie: now } });
    // A service account's token reads with Bearer; the ingest token does not.
    const bearer = (await import(root + "/control/owner-for-tests.ts")).ownerBearer("ci");
    await go("token", "/api/saved-searches", { headers: { authorization: bearer } });
    await go("tokenInstance", "/api/instance", { headers: { authorization: bearer } });
    await go("ingestOnApi", "/api/saved-searches", { headers: { authorization: "Bearer ingest-only" } });
    for (let i = 0; i < 6; i++) await go("miss" + i, "/api/sign-in", form("dev@agental.io", "wrong wrong wrong"));
    await go("slowed", "/api/sign-in", form("dev@agental.io", "wrong wrong wrong"));
    await go("signOut", "/api/sign-out", { method: "POST", headers: { cookie: now } });
    await go("afterSignOut", "/api/saved-searches", { headers: { cookie: now } });
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
      TOPOSCOPE_PASSWORD: "ignored-since-0.9",
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

describe("people sign in, and there is no shared password (#305)", () => {
  test("with no Owner, a page says how to make one on the host, and nothing else signs in", () => {
    expect(r.pageNoOwner!.status).toBe(401);
    expect(r.pageNoOwner!.type).toContain("text/html");
    expect(r.pageNoOwner!.challenge).toBeNull();
    expect(r.pageNoOwner!.body).toContain("This instance has no Owner yet");
    expect(r.pageNoOwner!.body).toContain("<h1>127.0.0.1:18080</h1>");
    expect(r.pageNoOwner!.body).toContain("./toposcope.sh owner-link");
    expect(r.pageNoOwner!.body).not.toContain('name="password"');
  });

  test("an API call without credentials is 401 with no Basic challenge, and Basic is refused", () => {
    expect(r.apiBare!.status).toBe(401);
    expect(r.apiBare!.challenge).toBeNull();
    expect(r.basic!.status).toBe(401);
    expect(r.basic!.challenge).toBeNull();
    expect(JSON.parse(r.basic!.body).error).toContain("Basic auth is gone");
  });

  test("an owner link makes the first Owner once, within its hour, with a 12-character password", () => {
    expect((r as unknown as Record<string, unknown>).linkMakes).toBe(true);
    expect(r.setupPage!.status).toBe(200);
    expect(r.setupPage!.body).toContain("Make the first Owner of");
    expect(r.setupPage!.body).toContain("ian@agental.io");
    expect(r.setupPage!.body).toMatch(/in (59|60) minutes/);
    expect(r.setupShort!.status).toBe(400);
    expect(r.setupShort!.body).toContain("12 characters or more");
    expect(r.setupDone!.status).toBe(303);
    expect(r.setupDone!.cookie).toMatch(/^toposcope_session_[0-9a-f]{8}=[^;]+; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Strict$/);
    expect(r.setupAgain!.status).toBe(410);
    expect(r.setupAgain!.body).toContain("This link no longer works");
    expect(r.setupReuse!.status).toBe(410);
    const me = JSON.parse(r.me!.body);
    expect(me).toMatchObject({ name: "Ian", email: "ian@agental.io", role: "owner", via: "session", initials: "IA" });
  });

  test("the page asks for an email and a password once there is an Owner, and names the instance", () => {
    expect(r.rename!.status).toBe(200);
    expect(r.pageNamed!.body).toContain("<title>Sign in · agental-prod</title>");
    expect(r.pageNamed!.body).toMatch(/<h1>agental-prod<\/h1><div class="addr">logs\.example\.test · \d+\.\d+\.\d+<\/div>/);
    expect(r.pageNamed!.body).toContain('name="email"');
    expect(r.pageNamed!.body).toContain('name="password"');
    expect(r.pageNamed!.body).not.toContain(".env");
  });

  test("a wrong password, or an email nobody has, is the same answer", () => {
    expect(r.wrong!.status).toBe(401);
    expect(r.wrong!.body).toContain("That email and password do not sign in to agental-prod.");
    expect(r.wrong!.body).toContain('value="ian@agental.io"');
    expect(r.wrong!.cookie).toBeNull();
    expect(r.noSuchEmail!.status).toBe(401);
    expect(r.noSuchEmail!.body).toContain("That email and password do not sign in");
  });

  test("the right one, in any case, sets a 30-day cookie and goes back where it was", () => {
    expect(r.right!.status).toBe(303);
    expect(r.right!.location).toBe("/?q=level:error");
    expect(r.offsite!.location).toBe("/");
    expect(r.withCookie!.status).toBe(200);
    expect(r.appPage!.status).toBe(200);
    expect(r.appPage!.body).toContain("the app");
    const info = JSON.parse(r.instance!.body);
    expect(info.name).toBe("agental-prod");
    expect(info.session.kind).toBe("cookie");
    expect(info.session.expires_at).toBeGreaterThan(Date.now() + 29 * 24 * 3600_000);
    expect(r.badCookie!.status).toBe(401);
  });

  test("owner-link for an Owner is the way back in: a new password, and their old sessions end", () => {
    expect((r as unknown as Record<string, unknown>).backMakes).toBe(false);
    expect(r.resetPage!.body).toContain("A new password for an Owner of");
    expect(r.reset!.status).toBe(303);
    expect(r.afterReset!.status).toBe(401);
    expect(r.oldPassword!.status).toBe(401);
    expect(r.newCookie!.status).toBe(200);
  });

  test("a service account token reads with Bearer; an ingest token reads nothing", () => {
    expect(r.token!.status).toBe(200);
    expect(JSON.parse(r.tokenInstance!.body).session.kind).toBe("token");
    expect(r.ingestOnApi!.status).toBe(401);
  });

  test("misses slow down, never lock", () => {
    expect(r.miss4!.status).toBe(401);
    expect(r.slowed!.status).toBe(429);
    expect(r.slowed!.body).toContain("the account is never locked");
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
