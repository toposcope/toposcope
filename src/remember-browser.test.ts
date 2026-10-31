import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserLabel } from "./control/remembered";
import { rememberSlider } from "./sign-in-page";

const root = import.meta.dir;
const fixture = mkdtempSync(join(tmpdir(), "toposcope-remember-"));
type R = { status: number; cookie: string | null; location: string | null; body: string };
let r: Record<string, R> & { n: Record<string, number> };

beforeAll(async () => {
  await Bun.write(join(fixture, "src/ui/dist/index.html"), "<!doctype html><html>the app</html>");
  // The real app, routing and SQLite, in a child, as sign-in.test.ts runs it.
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
    const out = { n: {} };
    const people = await import(root + "/control/people.ts");
    const remembered = await import(root + "/control/remembered.ts");
    const helpers = await import(root + "/control/owner-for-tests.ts");
    const chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
    const go = async (key, path, init = {}) => {
      const res = await app.fetch(new Request("http://app.test" + path, { redirect: "manual", ...init }));
      out[key] = { status: res.status, cookie: res.headers.get("set-cookie"), location: res.headers.get("location"), body: await res.text() };
      return out[key];
    };
    const pair = (setCookie) => setCookie.split(";")[0];
    const signIn = (key, email, cookie) =>
      go(key, "/api/sign-in", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": chrome, ...(cookie ? { cookie } : {}) }, body: new URLSearchParams({ email, password: "correct horse battery", next: "/?q=x" }).toString() });
    const verify = (key, cookie, fields, https = false) =>
      go(key, "/api/two-step/verify", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": chrome, cookie, ...(https ? { "x-forwarded-proto": "https" } : {}) }, body: new URLSearchParams(fields).toString() });
    const api = (key, path, cookie, init = {}) => go(key, path, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) } });

    // Ian, the first Owner, and Maya, an Operator, each with two-step.
    const link = people.createOwnerLink("ian@agental.io");
    const made = await go("setup", "/api/setup", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: link.token, name: "Ian", password: "correct horse battery" }).toString() });
    const ianCodes = await helpers.passTwoStepSetup(app.fetch, pair(made.cookie));
    const ianId = JSON.parse((await go("me0", "/api/me", { headers: { cookie: pair(made.cookie) } })).body).id;
    const invite = people.createInvite({ who: "maya@agental.io", role: "operator", created_by: ianId });
    const joined = await go("join", "/api/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: invite.token, name: "Maya", email: "maya@agental.io", password: "correct horse battery" }) });
    const mayaCodes = await helpers.passTwoStepSetup(app.fetch, pair(joined.cookie));
    const mayaId = JSON.parse(joined.body).id;

    // 34b: the slider on the code page; 34c: ticking 7 days remembers this browser.
    const s1 = pair((await signIn("ianIn", "ian@agental.io")).cookie);
    await go("verifyPage", "/two-step", { headers: { cookie: s1, accept: "text/html" } });
    const set = await verify("remember7", s1, { code: await helpers.currentCode(ianId, 1), remember: "7" }, true);
    const rIan = pair(set.cookie);
    // 34e: the password on that browser goes straight in.
    const s2 = pair((await signIn("skip", "ian@agental.io", rIan)).cookie);
    await go("meSkip", "/api/me", { headers: { cookie: s2 } });
    await go("mine", "/api/me/remembered-browsers", { headers: { cookie: s2 + "; " + rIan } });
    await signIn("otherBrowser", "ian@agental.io");
    await signIn("otherPerson", "maya@agental.io", rIan);
    const m1 = pair((await signIn("mayaIn", "maya@agental.io")).cookie);
    const mSet = await verify("maya14", m1, { code: await helpers.currentCode(mayaId, 1), remember: "14" });
    const rMaya = pair(mSet.cookie);
    await api("peopleList", "/api/people", s2);

    // 34h: an Owner caps the days; the slider stops there and remembered browsers shorten.
    await api("cap7", "/api/sign-in-settings", s2, { method: "PUT", body: JSON.stringify({ remember_days_max: 7 }) });
    await api("capBad", "/api/sign-in-settings", s2, { method: "PUT", body: JSON.stringify({ remember_days_max: 3 }) });
    out.mayaAfterCap = remembered.rememberedBrowsersOf(mayaId, undefined)[0];
    const s3 = pair((await signIn("ianAgain", "ian@agental.io")).cookie);
    await go("cappedPage", "/two-step", { headers: { cookie: s3, accept: "text/html" } });
    await verify("asked30", s3, { backup: ianCodes[0], remember: "30" });

    // 34f: forgetting one asks for the code there again.
    const mine = JSON.parse(out.mine.body).browsers;
    await api("forgetOne", "/api/me/remembered-browsers/" + mine[0].id, s2, { method: "DELETE" });
    await api("forgetNotMine", "/api/me/remembered-browsers/" + remembered.rememberedBrowsersOf(mayaId, undefined)[0].id, s2, { method: "DELETE" });
    await signIn("afterForget", "ian@agental.io", rIan);

    // 34g: an Owner forgets Maya's browsers.
    await api("ownerForget", "/api/people/" + mayaId + "/remembered-browsers", s2, { method: "DELETE" });
    await signIn("mayaAfterOwner", "maya@agental.io", rMaya);
    out.n.mayaAfterOwner = remembered.rememberedSummary(mayaId).count;

    // A two-step reset, revoking and a new password each forget them all.
    const m2 = pair((await signIn("mayaIn2", "maya@agental.io")).cookie);
    await verify("maya7", m2, { backup: mayaCodes[0], remember: "7" });
    out.n.mayaBeforeReset = remembered.rememberedSummary(mayaId).count;
    await api("reset", "/api/people/" + mayaId + "/two-step", s2, { method: "DELETE" });
    out.n.mayaAfterReset = remembered.rememberedSummary(mayaId).count;
    remembered.rememberBrowser(mayaId, 7, {});
    await api("revoke", "/api/people/" + mayaId, s2, { method: "DELETE" });
    out.n.mayaAfterRevoke = remembered.rememberedSummary(mayaId).count;

    // Never: a code at every sign-in, and every browser forgotten.
    out.n.ianBeforeNever = remembered.rememberedSummary(ianId).count;
    await api("never", "/api/sign-in-settings", s2, { method: "PUT", body: JSON.stringify({ remember_days_max: 0 }) });
    out.n.ianAfterNever = remembered.rememberedSummary(ianId).count;
    const s4 = pair((await signIn("ianNever", "ian@agental.io")).cookie);
    await go("neverPage", "/two-step", { headers: { cookie: s4, accept: "text/html" } });
    remembered.writeRememberDaysMax(30);
    remembered.rememberBrowser(ianId, 30, {});
    await people.setPassword(ianId, "another long password");
    out.n.ianAfterPassword = remembered.rememberedSummary(ianId).count;
    console.log(JSON.stringify(out));
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", script], {
    cwd: fixture,
    env: {
      ...process.env,
      NODE_PATH: join(root, "../node_modules"),
      TOPOSCOPE_DEV: "1",
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

const day = 24 * 60 * 60_000;

describe("remember this browser after the two-step code (34a–34i)", () => {
  test("the code page has the slider, Off by default, from Off to 30 days", () => {
    const body = r.verifyPage!.body;
    expect(body).toContain("<legend class=\"remh\"><span>Remember this browser</span>");
    for (const d of [0, 1, 7, 14, 30]) expect(body).toContain(`id="rem-${d}" name="remember" value="${d}"`);
    expect(body).toContain('value="0" checked');
    expect(body).toContain("Off: a code at every sign-in, as now.");
  });

  test("ticking 7 days sets a per-instance, HttpOnly, SameSite=Strict cookie for 7 days, Secure over HTTPS", () => {
    expect(r.remember7!.status).toBe(303);
    expect(r.remember7!.cookie).toMatch(/^toposcope_remember_[0-9a-f]{8}=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=604800; HttpOnly; SameSite=Strict; Secure$/);
    expect(r.maya14!.cookie).toMatch(/Max-Age=1209600; HttpOnly; SameSite=Strict$/);
  });

  test("the password on a remembered browser goes straight in, and /api/me says so", () => {
    expect(r.skip!.status).toBe(303);
    expect(r.skip!.location).toBe("/?q=x");
    expect(r.skip!.cookie).toMatch(/Max-Age=2592000/);
    const me = JSON.parse(r.meSkip!.body);
    expect(me.remembered.until).toBeGreaterThan(Date.now() + 6 * day);
    expect(me.remembered.until).toBeLessThanOrEqual(Date.now() + 7 * day);
  });

  test("another browser, or another person with that cookie, is still asked", () => {
    expect(r.otherBrowser!.location).toBe("/two-step");
    expect(r.otherPerson!.location).toBe("/two-step");
  });

  test("a person sees their remembered browsers, this one marked; People counts them", () => {
    const list = JSON.parse(r.mine!.body).browsers;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ label: "Chrome on macOS", days: 7, this_browser: true });
    const maya = JSON.parse(r.peopleList!.body).people.find((p: { email: string }) => p.email === "maya@agental.io");
    expect(maya.two_step.remembered.count).toBe(1);
  });

  test("an Owner's cap stops the slider and shortens what is remembered", () => {
    expect(r.cap7!.status).toBe(200);
    expect(JSON.parse(r.cap7!.body).remember_days_max).toBe(7);
    expect(r.capBad!.status).toBe(400);
    const maya = (r as unknown as { mayaAfterCap: { days: number; created_at: number; expires_at: number } }).mayaAfterCap;
    expect(maya.days).toBe(7);
    expect(maya.expires_at - maya.created_at).toBe(7 * day);
    expect(r.cappedPage!.body).toContain('id="rem-7"');
    expect(r.cappedPage!.body).not.toContain('id="rem-14"');
    expect(r.asked30!.cookie).toMatch(/Max-Age=604800;/);
  });

  test("forgetting one asks for the code there again; another person's is not mine to forget", () => {
    expect(r.forgetOne!.status).toBe(200);
    expect(r.forgetNotMine!.status).toBe(404);
    expect(r.afterForget!.location).toBe("/two-step");
  });

  test("an Owner forgets someone's browsers", () => {
    expect(JSON.parse(r.ownerForget!.body).forgotten).toBe(1);
    expect(r.mayaAfterOwner!.location).toBe("/two-step");
    expect(r.n.mayaAfterOwner).toBe(0);
  });

  test("a two-step reset, revoking and a new password forget them all", () => {
    expect(r.n.mayaBeforeReset).toBe(1);
    expect(r.n.mayaAfterReset).toBe(0);
    expect(r.n.mayaAfterRevoke).toBe(0);
    expect(r.n.ianAfterPassword).toBe(0);
  });

  test("never hides the slider and forgets every browser", () => {
    expect(r.n.ianBeforeNever).toBeGreaterThan(0);
    expect(r.n.ianAfterNever).toBe(0);
    expect(r.neverPage!.body).toContain("The six digits from your authenticator app");
    expect(r.neverPage!.body).not.toContain("<fieldset class=\"rem\">");
  });
});

describe("the slider and the label", () => {
  test("a kept pick stays checked, dates are UTC days", () => {
    const html = rememberSlider(30, 14, Date.UTC(2026, 10, 1, 14, 20));
    expect(html).toContain('value="14" checked');
    expect(html).toContain("until Sun 15 Nov.");
    expect(html).toContain("until Tue 1 Dec.");
    expect(rememberSlider(0, 0, 0)).toBe("");
  });

  test("a browser is named from its User-Agent", () => {
    expect(browserLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")).toBe("Safari on iPhone");
    expect(browserLabel("Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0")).toBe("Firefox on Linux");
    expect(browserLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Edg/141.0")).toBe("Edge on Windows");
    expect(browserLabel(undefined)).toBe("A browser");
  });
});
