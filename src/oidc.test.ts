import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = import.meta.dir;
const fixture = mkdtempSync(join(tmpdir(), "toposcope-oidc-"));
type R = { status: number; body: any; cookie?: string | null; location?: string | null };
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
    // A provider on idp.test: discovery, keys, and a token endpoint that signs RS256 ID tokens.
    const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const jwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const codes = new Map();
    const sign = async (claims) => {
      const head = b64({ alg: "RS256", kid: "k1", typ: "JWT" }) + "." + b64(claims);
      const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(head));
      return head + "." + Buffer.from(sig).toString("base64url");
    };
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.endsWith("/ping")) return new Response("Ok.");
      if (u.startsWith("http://clickhouse.test")) return Response.json({ data: [] });
      if (u === "http://idp.test/.well-known/openid-configuration") return Response.json({ issuer: "http://idp.test", authorization_endpoint: "http://idp.test/authorize", token_endpoint: "http://idp.test/token", jwks_uri: "http://idp.test/jwks" });
      if (u === "http://idp.test/jwks") return Response.json({ keys: [jwk] });
      if (u === "http://idp.test/token") {
        const form = new URLSearchParams(String(init.body));
        const grant = codes.get(form.get("code"));
        if (!grant || form.get("client_secret") !== "s3cret") return Response.json({ error: "invalid_grant" }, { status: 400 });
        const verifier = form.get("code_verifier");
        const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
        if (challenge !== grant.challenge) return Response.json({ error: "invalid_grant", error_description: "PKCE" }, { status: 400 });
        const now = Math.floor(Date.now() / 1000);
        return Response.json({ id_token: await sign({ iss: "http://idp.test", aud: grant.aud ?? "toposcope-app", exp: now + 300, iat: now, nonce: grant.nonce, sub: grant.sub, email: grant.email, email_verified: grant.verified ?? true, name: grant.name }) });
      }
      throw new Error("Unexpected external fetch " + u);
    };
    const app = (await import(root + "/index.ts")).default;
    for (let i = 0; i < 50; i++) {
      if ((await app.fetch(new Request("http://app.test/api/health"))).status === 200) break;
      await new Promise((ok) => setTimeout(ok, 0));
    }
    const people = await import(root + "/control/people.ts");
    const helpers = await import(root + "/control/owner-for-tests.ts");
    const out = {};
    const go = async (key, path, init = {}) => {
      const res = await app.fetch(new Request("http://app.test" + path, { redirect: "manual", ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } }));
      const text = await res.text();
      out[key] = { status: res.status, body: text.startsWith("{") ? JSON.parse(text) : text, cookie: res.headers.get("set-cookie"), location: res.headers.get("location") };
      return out[key];
    };
    // The provider signs someone in: start, the provider's grant, the callback.
    const viaProvider = async (key, who, extra = "") => {
      const start = await go(key + "Start", "/auth/start" + extra);
      const at = new URL(start.location);
      const code = "c-" + Math.random().toString(36).slice(2);
      codes.set(code, { ...who, nonce: at.searchParams.get("nonce"), challenge: at.searchParams.get("code_challenge") });
      return go(key, "/auth/callback?code=" + code + "&state=" + at.searchParams.get("state"));
    };
    const link = people.createOwnerLink("ian@agental.io");
    const ian = (await go("ian", "/api/setup", { method: "POST", body: JSON.stringify({ token: link.token, name: "Ian", password: "ian's long password" }) })).cookie.split(";")[0];
    await helpers.passTwoStepSetup(app.fetch, ian);
    await go("viewerCannot", "/api/sign-in-settings", {});
    await go("badIssuer", "/api/sign-in-settings", { method: "PUT", headers: { cookie: ian }, body: JSON.stringify({ oidc: { preset: "google", issuer: "ftp://nope", client_id: "x", client_secret: "y" } }) });
    await go("save", "/api/sign-in-settings", { method: "PUT", headers: { cookie: ian }, body: JSON.stringify({ oidc: { preset: "google", label: "Google", issuer: "http://idp.test", client_id: "toposcope-app", client_secret: "s3cret", allowed_domain: "agental.io", without_invite: "viewer" } }) });
    await go("read", "/api/sign-in-settings", { headers: { cookie: ian } });
    await go("page", "/", { headers: { accept: "text/html" } });
    const maya = await viaProvider("maya", { sub: "g-maya", email: "maya@agental.io", name: "Maya K." });
    await go("mayaMe", "/api/me", { headers: { cookie: maya.cookie.split(";")[0] } });
    await viaProvider("outside", { sub: "g-x", email: "x@elsewhere.io", name: "X" });
    await viaProvider("unverified", { sub: "g-u", email: "u@agental.io", name: "U", verified: false });
    await viaProvider("wrongAud", { sub: "g-w", email: "w@agental.io", name: "W", aud: "someone-else" });
    await go("badState", "/auth/callback?code=whatever&state=not-a-state");
    // An invite through the provider gives the invite's role.
    const inv = await go("invite", "/api/people/invites", { method: "POST", headers: { cookie: ian }, body: JSON.stringify({ who: "dev@agental.io", role: "operator" }) });
    const token = inv.body.link.slice(inv.body.link.indexOf("/join/") + 6);
    await go("joinPage", "/join/" + token, { headers: { accept: "text/html" } });
    const dev = await viaProvider("dev", { sub: "g-dev", email: "dev@agental.io", name: "Dev R." }, "?invite=" + encodeURIComponent(token));
    await go("devMe", "/api/me", { headers: { cookie: dev.cookie.split(";")[0] } });
    // Passwords off: refused while an Owner has no provider sign-in; then the provider only.
    await go("offTooSoon", "/api/sign-in-settings", { method: "PUT", headers: { cookie: ian }, body: JSON.stringify({ passwords: false }) });
    await viaProvider("ianLinks", { sub: "g-ian", email: "ian@agental.io", name: "Ian" });
    await go("off", "/api/sign-in-settings", { method: "PUT", headers: { cookie: ian }, body: JSON.stringify({ passwords: false }) });
    await go("passwordRefused", "/api/sign-in", { method: "POST", body: JSON.stringify({ email: "ian@agental.io", password: "ian's long password" }) });
    await go("pageOff", "/", { headers: { accept: "text/html" } });
    await go("removeWhileOff", "/api/sign-in-settings", { method: "PUT", headers: { cookie: ian }, body: JSON.stringify({ oidc: null }) });
    console.log(JSON.stringify(out));
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", script], {
    cwd: fixture,
    env: { ...process.env, NODE_PATH: join(root, "../node_modules"), TOPOSCOPE_DEV: "1", TOPOSCOPE_INGEST_TOKEN: "", SQLITE_PATH: ":memory:", CLICKHOUSE_URL: "http://clickhouse.test", OTLP_GRPC_PORT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  r = JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!);
});

afterAll(() => rmSync(fixture, { recursive: true, force: true }));

describe("sign in with one OIDC provider (#310)", () => {
  test("an Owner sets it up; the secret is never shown back", () => {
    expect(r.viewerCannot!.status).toBe(401);
    expect(r.badIssuer!.status).toBe(400);
    expect(r.save!.status).toBe(200);
    expect(r.read!.body.oidc).toMatchObject({ issuer: "http://idp.test", client_id: "toposcope-app", allowed_domain: "agental.io" });
    expect(JSON.stringify(r.read!.body)).not.toContain("s3cret");
    expect(r.read!.body.redirect_uri).toMatch(/^http:\/\/[^/]+\/auth\/callback$/);
  });

  test("the sign-in page leads with the provider", () => {
    expect(r.page!.body).toContain("Continue with Google · agental.io");
    expect(r.page!.body).toContain('href="/auth/start?next=%2F"');
    expect(r.page!.body).toContain("or with a password");
  });

  test("code flow with PKCE: a verified address in the domain joins as the default role", () => {
    expect(r.mayaStart!.status).toBe(302);
    expect(r.mayaStart!.location).toContain("code_challenge_method=S256");
    expect(r.maya!.status).toBe(303);
    expect(r.mayaMe!.body).toMatchObject({ name: "Maya K.", email: "maya@agental.io", role: "viewer" });
  });

  test("another domain, an unverified email, another client or a state it never made are refused", () => {
    expect(r.outside!.status).toBe(401);
    expect(r.outside!.body).toContain("Only agental.io addresses sign in here");
    expect(r.unverified!.status).toBe(401);
    expect(r.unverified!.body).toContain("verified email");
    expect(r.wrongAud!.status).toBe(401);
    expect(r.wrongAud!.body).toContain("another client");
    expect(r.badState!.status).toBe(401);
  });

  test("an invite through the provider gives the invite's role", () => {
    expect(r.joinPage!.body).toContain("Continue with Google as dev@agental.io");
    expect(r.dev!.status).toBe(303);
    expect(r.devMe!.body).toMatchObject({ email: "dev@agental.io", role: "operator" });
  });

  test("passwords go off only once every Owner can sign in with the provider", () => {
    expect(r.offTooSoon!.status).toBe(400);
    expect(r.offTooSoon!.body.error).toContain("Every Owner");
    expect(r.ianLinks!.status).toBe(303);
    expect(r.off!.status).toBe(200);
    expect(r.off!.body.passwords).toBe(false);
    expect(r.passwordRefused!.status).toBe(401);
    expect(r.pageOff!.body).not.toContain('name="password"');
    expect(r.removeWhileOff!.status).toBe(400);
  });
});
