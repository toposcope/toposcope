import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = import.meta.dir;
const fixture = mkdtempSync(join(tmpdir(), "toposcope-people-"));
type R = { status: number; body: any; cookie?: string | null };
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
    const out = {};
    const go = async (key, path, init = {}) => {
      const res = await app.fetch(new Request("http://app.test" + path, { redirect: "manual", ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } }));
      const text = await res.text();
      out[key] = { status: res.status, body: text.startsWith("{") ? JSON.parse(text) : text, cookie: res.headers.get("set-cookie") };
      return out[key];
    };
    const as = (cookie) => ({ headers: { cookie } });
    // The first Owner, as owner-link makes them.
    const link = people.createOwnerLink("ian@example.test");
    const ian = (await go("ian", "/api/setup", { method: "POST", body: JSON.stringify({ token: link.token, name: "Ian", password: "ian's long password" }) })).cookie.split(";")[0];
    // The .env ingest token was imported once at boot, and still sends; .env is not read for it again.
    await go("envSends", "/api/ingest", { method: "POST", headers: { authorization: "Bearer imported-ingest-token-308" }, body: "[]" });
    await go("access", "/api/access", as(ian));
    // Invite someone (30b) and join (30c).
    const inv = await go("invite", "/api/people/invites", { method: "POST", headers: { cookie: ian }, body: JSON.stringify({ who: "Sam@Contractor.dev", role: "viewer", days: 7 }) });
    await go("listed", "/api/people", as(ian));
    const tokenOf = (url) => url.slice(url.indexOf("/join/") + 6);
    await go("joinPage", "/join/" + tokenOf(inv.body.link), { headers: { accept: "text/html" } });
    const sam = (await go("join", "/api/join", { method: "POST", body: JSON.stringify({ token: tokenOf(inv.body.link), name: "Sam", password: "sam's long password" }) })).cookie.split(";")[0];
    await go("joinAgain", "/api/join", { method: "POST", body: JSON.stringify({ token: tokenOf(inv.body.link), name: "Sam", password: "sam's long password" }) });
    await go("samMe", "/api/me", as(sam));
    await go("samInvites", "/api/people/invites", { method: "POST", headers: { cookie: sam }, body: JSON.stringify({ who: "x@y.z", role: "owner" }) });
    // A personal token, read only.
    const tok = await go("samToken", "/api/me/tokens", { method: "POST", headers: { cookie: sam }, body: JSON.stringify({ name: "laptop scripts", read_only: true }) });
    await go("samTokenReads", "/api/saved-searches", { headers: { authorization: "Bearer " + tok.body.token } });
    // Roles change; the last Owner stays an Owner.
    const samId = out.samMe.body.id;
    await go("promote", "/api/people/" + samId, { method: "PUT", headers: { cookie: ian }, body: JSON.stringify({ role: "operator" }) });
    await go("samMeAfter", "/api/me", as(sam));
    await go("demoteLast", "/api/people/" + out.ian.body?.id, { method: "PUT", headers: { cookie: ian }, body: JSON.stringify({ role: "viewer" }) });
    const ianId = (await go("ianMe", "/api/me", as(ian))).body.id;
    await go("demoteLastOwner", "/api/people/" + ianId, { method: "PUT", headers: { cookie: ian }, body: JSON.stringify({ role: "viewer" }) });
    // A service account and its token (32f).
    const svc = await go("service", "/api/people/service-accounts", { method: "POST", headers: { cookie: ian }, body: JSON.stringify({ name: "agental-boards", role: "operator" }) });
    const st = await go("serviceToken", "/api/people/" + svc.body.id + "/tokens", { method: "POST", headers: { cookie: ian }, body: JSON.stringify({ name: "board sync" }) });
    await go("serviceWrites", "/api/fields", { method: "PUT", headers: { authorization: "Bearer " + st.body.token }, body: JSON.stringify({ roles: {}, links: {} }) });
    await go("serviceSignsIn", "/api/sign-in", { method: "POST", body: JSON.stringify({ email: "agental-boards", password: "anything at all" }) });
    // Revoke: sessions and tokens end on the next request.
    await go("revoke", "/api/people/" + samId, { method: "DELETE", headers: { cookie: ian } });
    await go("samAfterRevoke", "/api/me", as(sam));
    await go("samTokenAfterRevoke", "/api/saved-searches", { headers: { authorization: "Bearer " + tok.body.token } });
    // An invite by name asks for the email; cancel takes an invite away.
    const byName = await go("inviteByName", "/api/people/invites", { method: "POST", headers: { cookie: ian }, body: JSON.stringify({ who: "Jo", role: "operator", days: 1 }) });
    await go("cancel", "/api/people/invites/" + byName.body.id, { method: "DELETE", headers: { cookie: ian } });
    await go("cancelledJoin", "/join/" + tokenOf(byName.body.link), { headers: { accept: "text/html" } });
    await go("listedAfter", "/api/people", as(ian));
    console.log(JSON.stringify(out));
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", script], {
    cwd: fixture,
    env: { ...process.env, NODE_PATH: join(root, "../node_modules"), TOPOSCOPE_DEV: "1", TOPOSCOPE_INGEST_TOKEN: "imported-ingest-token-308", SQLITE_PATH: ":memory:", CLICKHOUSE_URL: "http://clickhouse.test", OTLP_GRPC_PORT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  r = JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!);
});

afterAll(() => rmSync(fixture, { recursive: true, force: true }));

describe("people in Access (#308)", () => {
  test("the .env ingest token is imported once as env (imported), and keeps sending", () => {
    // 400 is an empty batch refused after the token was taken; 401 would be the token refused.
    expect(r.envSends!.status).toBe(400);
    const names = r.access!.body.rows.map((row: { name: string }) => row.name);
    expect(names).toContain("env (imported)");
    expect(names).not.toContain("TOPOSCOPE_INGEST_TOKEN");
  });

  test("an invite is a link shown once; joining makes a person with its role", () => {
    expect(r.invite!.status).toBe(201);
    expect(r.invite!.body.link).toMatch(/^http:\/\/app\.test\/join\/tsi1_/);
    expect(r.listed!.body.invites).toEqual([expect.objectContaining({ who: "sam@contractor.dev", role: "viewer", invited_by: "Ian" })]);
    expect(r.joinPage!.status).toBe(200);
    expect(r.joinPage!.body).toContain("Ian invited you to");
    expect(r.joinPage!.body).toContain("sam@contractor.dev");
    expect(r.join!.status).toBe(200);
    expect(r.joinAgain!.status).toBe(410);
    expect(r.samMe!.body).toMatchObject({ name: "Sam", email: "sam@contractor.dev", role: "viewer" });
    expect(r.samInvites!.status).toBe(403);
  });

  test("a read-only personal token reads as its person", () => {
    expect(r.samToken!.status).toBe(201);
    expect(r.samToken!.body.token).toMatch(/^tsp1_/);
    expect(r.samTokenReads!.status).toBe(200);
  });

  test("an Owner changes roles, and the last Owner stays an Owner", () => {
    expect(r.promote!.status).toBe(200);
    expect(r.samMeAfter!.body.role).toBe("operator");
    expect(r.demoteLastOwner!.status).toBe(409);
    expect(r.demoteLastOwner!.body.error).toContain("last Owner");
  });

  test("a service account holds tokens, acts with its role, and cannot sign in", () => {
    expect(r.service!.status).toBe(201);
    expect(r.service!.body).toMatchObject({ kind: "service", role: "operator", signs_in_with: "tokens only" });
    expect(r.serviceToken!.status).toBe(201);
    expect(r.serviceWrites!.status).toBe(200);
    expect(r.serviceSignsIn!.status).toBe(400);
  });

  test("revoke ends a person's sessions and tokens on the next request", () => {
    expect(r.revoke!.status).toBe(200);
    expect(r.samAfterRevoke!.status).toBe(401);
    expect(r.samTokenAfterRevoke!.status).toBe(401);
  });

  test("a cancelled invite no longer opens", () => {
    expect(r.inviteByName!.status).toBe(201);
    expect(r.cancel!.status).toBe(200);
    expect(r.cancelledJoin!.status).toBe(410);
    const after = r.listedAfter!.body;
    expect(after.invites).toEqual([]);
    expect(after.people.map((p: { name: string }) => p.name)).toEqual(["Ian"]);
    expect(after.service_accounts.map((p: { name: string }) => p.name)).toEqual(["agental-boards"]);
  });
});
