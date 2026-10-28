import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = import.meta.dir;
const fixture = mkdtempSync(join(tmpdir(), "toposcope-monitors-"));
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
    const hooked = [];
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith("/ping")) return new Response("Ok.");
      if (String(url).startsWith("http://hook.test/")) {
        hooked.push({ url: String(url), body: String(init?.body ?? ""), type: init?.headers?.["content-type"] ?? "" });
        return new Response("queued");
      }
      if (String(url).startsWith("http://clickhouse.test")) return Response.json({ data: [] });
      throw new Error("Unexpected external fetch");
    };
    const app = (await import(root + "/index.ts")).default;
    for (let i = 0; i < 50; i++) {
      if ((await app.fetch(new Request("http://app.test/api/health"))).status === 200) break;
      await new Promise((ok) => setTimeout(ok, 0));
    }
    const out = {};
    const auth = { authorization: (await import(root + "/control/owner-for-tests.ts")).ownerBearer(), "content-type": "application/json" };
    const go = async (key, path, method = "GET", body) => {
      // Every monitor names its service (#335): a fixture that does not name one is about "api".
      if (body && typeof body === "object" && !("service" in body) && !("enabled" in body) && !("silence_for" in body) && (method === "PUT" || method === "POST") && (path.startsWith("/api/monitors/") || path.startsWith("/api/alert-rules"))) body = { service: "api", ...body };
      const res = await app.fetch(new Request("http://app.test" + path, { method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body) }));
      const text = await res.text();
      out[key] = { status: res.status, body: text.startsWith("{") ? JSON.parse(text) : text };
      return out[key];
    };
    const saved = (await go("saved", "/api/saved-searches", "POST", { name: "api errors search", query: "service:api level:error", range: "15m" })).body;
    const hook = "https://hooks.example.com/page";
    const made = (await go("create", "/api/alert-rules", "POST", { name: "api errors", saved_search_id: saved.id, threshold: 50, webhook_url: hook })).body;
    await go("list", "/api/alert-rules");
    await go("update", "/api/alert-rules/" + made.id, "PUT", { threshold: 60, remind_every: "1h" });
    await go("badRemind", "/api/alert-rules/" + made.id, "PUT", { remind_every: "2h" });
    await go("pause", "/api/alert-rules/" + made.id, "PUT", { enabled: false });
    await go("resume", "/api/alert-rules/" + made.id, "PUT", { enabled: true });
    await go("declare", "/api/monitors/ci-box%20went%20quiet", "PUT", { source: "search", saved_search: "api errors search", threshold: 1, webhook_url: hook });
    await go("redeclare", "/api/monitors/ci-box%20went%20quiet", "PUT", { source: "search", saved_search_id: saved.id, threshold: 3, webhook_url: hook, remind_every: "off" });
    await go("noSource", "/api/monitors/x", "PUT", { saved_search_id: saved.id, threshold: 1, webhook_url: hook });
    await go("noService", "/api/monitors/x", "PUT", { service: "", source: "search", saved_search_id: saved.id, threshold: 1, webhook_url: hook });
    await go("named", "/api/monitors/named", "PUT", { service: "billing", source: "search", saved_search_id: saved.id, threshold: 1, webhook_url: hook });
    await go("namedGone", "/api/monitors/named", "DELETE");
    // A monitor made before 0.10 has no service: it can still be paused, resumed and silenced (#335).
    const older = (await go("older", "/api/alert-rules", "POST", { name: "older", service: "api", saved_search_id: saved.id, threshold: 1, webhook_url: hook })).body;
    (await import(root + "/control/index.ts")).getDb().query("UPDATE alert_rules SET service = '' WHERE id = ?").run(older.id);
    await go("olderPause", "/api/alert-rules/" + older.id, "PUT", { enabled: false });
    await go("olderSilence", "/api/alert-rules/" + older.id, "PUT", { silence_for: "1h" });
    await go("olderEdit", "/api/alert-rules/" + older.id, "PUT", { threshold: 2, service: "" });
    await go("olderGone", "/api/alert-rules/" + older.id, "DELETE");
    await go("noSearch", "/api/monitors/x", "PUT", { source: "search", saved_search: "no such search", threshold: 1, webhook_url: hook });
    await go("fpResolved", "/api/monitors/x", "PUT", { source: "fingerprints", saved_search_id: saved.id, threshold: 1, webhook_url: hook, body_kind: "text", body_template: "{{alert.name}}", resolved_body: "{{alert.name}} resolved" });
    await go("badResolved", "/api/monitors/x", "PUT", { source: "search", saved_search_id: saved.id, threshold: 1, webhook_url: hook, body_kind: "text", body_template: "{{alert.name}}", resolved_body: "{{mark.kind}} resolved" });
    await go("withResolved", "/api/monitors/ntfy", "PUT", { source: "search", saved_search_id: saved.id, threshold: 1, webhook_url: hook, body_kind: "text", body_template: "{{alert.name}} {{state}}", resolved_body: "{{alert.name}} resolved after {{duration}}" });
    await go("monitors", "/api/monitors");
    await go("monitors7d", "/api/monitors?range=7d");
    await go("monitorsHunt", "/api/monitors?from=2026-10-19T11:03:00.000Z&to=2026-10-20T11:03:00.000Z");
    await go("monitorsBad", "/api/monitors?range=1h");
    await go("one", "/api/monitors/ci-box%20went%20quiet");
    await go("dupA", "/api/alert-rules", "POST", { name: "twice", saved_search_id: saved.id, threshold: 1, webhook_url: hook });
    await go("dupB", "/api/alert-rules", "POST", { name: "twice", saved_search_id: saved.id, threshold: 1, webhook_url: hook });
    await go("dupPut", "/api/monitors/twice", "PUT", { source: "search", saved_search_id: saved.id, threshold: 1, webhook_url: hook });
    await go("delete", "/api/monitors/ci-box%20went%20quiet", "DELETE");
    await go("gone", "/api/monitors/ci-box%20went%20quiet");
    await go("deleteSearch", "/api/saved-searches/" + saved.id, "DELETE");
    // HTTP(S) monitors (#178), against a stand on a spare port.
    const stand = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => Response.json({ db: "down", auth: req.headers.get("authorization") }) });
    const standUrl = "http://127.0.0.1:" + stand.port + "/health";
    const httpBody = { source: "http", url: "https://api.example.com/health", every: "30s", conditions: ["status == 200", "time < 300ms warn"], headers: { Authorization: "Bearer s3cret" }, webhook_url: hook };
    const declared = (await go("httpDeclare", "/api/monitors/api-health", "PUT", httpBody)).body;
    await go("httpBadLine", "/api/monitors/bad", "PUT", { ...httpBody, conditions: "status == 200\\nbody has ok" });
    await go("httpBadEvery", "/api/monitors/bad", "PUT", { ...httpBody, every: "10s" });
    await go("httpWindow", "/api/monitors/bad", "PUT", { ...httpBody, remind_every: "window" });
    await go("httpNoUrl", "/api/monitors/bad", "PUT", { ...httpBody, url: "ftp://api.example.com/" });
    await go("httpKeep", "/api/alert-rules/" + declared.id, "PUT", { url: standUrl, headers: { Authorization: null } });
    await go("httpPause", "/api/alert-rules/" + declared.id, "PUT", { enabled: false });
    await go("httpOne", "/api/monitors/api-health");
    const listed = await app.fetch(new Request("http://app.test/api/monitors", { headers: auth }));
    out.httpListText = { status: listed.status, body: await listed.text() };
    await go("httpSend", "/api/monitors/send", "POST", { url: standUrl, method: "GET", conditions: '$.db == "ok"' });
    await go("httpSendKept", "/api/monitors/send", "POST", { id: declared.id, url: standUrl, method: "GET", headers: { Authorization: null } });
    await go("httpSendBad", "/api/monitors/send", "POST", { url: "ftp://x/" });
    await go("httpSendBadLine", "/api/monitors/send", "POST", { url: standUrl, conditions: "$..db == 1" });
    await go("httpTestCall", "/api/alert-rules/test-call", "POST", { source: "http", name: "api-health", url: "https://api.example.com/health", method: "GET", webhook_url: "http://hook.test/ntfy", body_kind: "text", body_template: "{{alert.name}} {{state}}: {{message}} ({{status}})", resolved_body: "{{alert.name}} {{state}}", run: { status: 503, duration_ms: 12, why: "status is 503, not 2xx" } });
    await go("httpTestCallBad", "/api/alert-rules/test-call", "POST", { source: "http", name: "x", webhook_url: "http://hook.test/ntfy", body_kind: "text", body_template: "{{series}}" });
    out.hooked = hooked.slice();
    await go("httpClash", "/api/monitors/api-health", "PUT", { source: "search", saved_search_id: saved.id, threshold: 1, webhook_url: hook });
    await go("httpNoHook", "/api/monitors/no-hook", "PUT", { source: "http", url: "https://api.example.com/health" });
    await go("httpBadHook", "/api/monitors/bad-hook", "PUT", { source: "http", url: "https://api.example.com/health", webhook_url: "ftp://x" });
    await go("httpCreate", "/api/alert-rules", "POST", { ...httpBody, name: "made in the dialog" });
    await go("httpDelete", "/api/monitors/api-health", "DELETE");
    await go("httpGone", "/api/monitors/api-health");
    // TCP and certificate monitors (#180), against a port on a spare port.
    const tcpStand = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open(s) { s.end(); } } });
    const tcpTarget = "127.0.0.1:" + tcpStand.port;
    const tcpBody = { source: "tcp", target: "db.internal:5432", every: "1m", conditions: ["connected", "time < 200ms warn"] };
    await go("tcpDeclare", "/api/monitors/db-port", "PUT", tcpBody);
    await go("tcpBadLine", "/api/monitors/bad", "PUT", { ...tcpBody, conditions: ["status == 200"] });
    await go("tcpBadTarget", "/api/monitors/bad", "PUT", { ...tcpBody, target: "tcp://db.internal:5432" });
    await go("tcpNoPort", "/api/monitors/bad", "PUT", { ...tcpBody, target: "db.internal" });
    await go("tcpStarttls", "/api/monitors/bad", "PUT", { ...tcpBody, starttls: "smtp" });
    const certBody = { source: "cert", target: "smtp.agental.dev:587", starttls: "smtp", every: "1h", conditions: ["cert > 14d", "cert name == smtp.agental.dev"] };
    const certMade = (await go("certDeclare", "/api/monitors/mail-cert", "PUT", certBody)).body;
    await go("certBadStarttls", "/api/monitors/bad", "PUT", { ...certBody, starttls: "ftp" });
    await go("certBadLine", "/api/monitors/bad", "PUT", { ...certBody, conditions: ["status == 200"] });
    await go("certUpdate", "/api/alert-rules/" + certMade.id, "PUT", { starttls: null, target: "imap.agental.dev:993" });
    await go("certOne", "/api/monitors/mail-cert");
    await go("netClash", "/api/monitors/db-port", "PUT", { source: "cert", target: "db.internal:5432" });
    await go("netClashSearch", "/api/monitors/mail-cert", "PUT", { source: "search", saved_search_id: saved.id, threshold: 1, webhook_url: hook });
    await go("netList", "/api/monitors");
    await go("tcpSend", "/api/monitors/send", "POST", { source: "tcp", target: tcpTarget, conditions: "connected\\ntime < 5000ms" });
    await go("tcpSendBad", "/api/monitors/send", "POST", { source: "tcp", target: "nope" });
    const netBefore = hooked.length;
    await go("certTestCall", "/api/alert-rules/test-call", "POST", { source: "cert", name: "mail-cert", target: "smtp.agental.dev:587", starttls: "smtp", webhook_url: "http://hook.test/ntfy", body_kind: "text", body_template: "{{alert.name}} {{state}}: {{message}} ({{target}})", run: { duration_ms: 40, why: "certificate expires in 6 days" } });
    await go("certTestCallBad", "/api/alert-rules/test-call", "POST", { source: "cert", name: "x", webhook_url: "http://hook.test/ntfy", body_kind: "text", body_template: "{{url}}" });
    out.netHooked = hooked.slice(netBefore);
    await go("tcpCreate", "/api/alert-rules", "POST", { ...tcpBody, name: "tcp from the dialog" });
    await go("tcpDelete", "/api/monitors/db-port", "DELETE");
    await go("tcpGone", "/api/monitors/db-port");
    tcpStand.stop(true);
    stand.stop(true);
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

describe("/api/alert-rules still answers as it did (#175)", () => {
  test("create answers 201 with the rule, which is now also a monitor", () => {
    expect(r.create!.status).toBe(201);
    expect(r.create!.body).toMatchObject({
      name: "api errors",
      kind: "threshold",
      threshold: 50,
      webhook_url: "https://hooks.example.com/page",
      enabled: 1,
      last_fired_at: null,
      last_attempt_at: null,
      consecutive_failures: 0,
      silenced_until: null,
      body_kind: "default",
      source: "search",
      state: "ok",
      remind_every: "4h",
    });
  });

  test("the list is { rules, link }", () => {
    expect(Object.keys(r.list!.body).sort()).toEqual(["link", "rules"]);
    expect(r.list!.body.rules.map((rule: { name: string }) => rule.name)).toEqual(["api errors"]);
  });

  test("an update keeps what it leaves out and takes remind_every", () => {
    expect(r.update!.status).toBe(200);
    expect(r.update!.body).toMatchObject({ threshold: 60, remind_every: "1h", name: "api errors" });
    expect(r.badRemind!.status).toBe(400);
    expect(r.badRemind!.body.error).toBe("remind_every must be off, window, 1h, 4h or 24h");
    expect(r.pause!.body.enabled).toBe(0);
    expect(r.resume!.body.enabled).toBe(1);
  });

  test("a saved search a monitor reads still cannot be deleted", () => {
    expect(r.deleteSearch!.status).toBe(409);
  });
});

describe("PUT /api/monitors/<name> (#175)", () => {
  test("creates a monitor of that name, then replaces it", () => {
    expect(r.declare!.status).toBe(201);
    expect(r.declare!.body).toMatchObject({ name: "ci-box went quiet", source: "search", threshold: 1, remind_every: "4h", state: "ok", open: null });
    expect(r.declare!.body.saved).toMatchObject({ name: "api errors search", query: "service:api level:error", range: "15m" });
    expect(r.redeclare!.status).toBe(200);
    expect(r.redeclare!.body.id).toBe(r.declare!.body.id);
    expect(r.redeclare!.body).toMatchObject({ threshold: 3, remind_every: "off" });
  });

  test("says what is wrong with a declaration", () => {
    // Every monitor names its service (#335), and says it back.
    expect(r.noService!.status).toBe(400);
    expect(r.noService!.body.error).toBe("A monitor names its service: the service it is about");
    expect(r.named!.body).toMatchObject({ service: "billing", host: "" });
    expect(r.olderPause!.status).toBe(200);
    expect(r.olderSilence!.status).toBe(200);
    expect(r.olderEdit!.status).toBe(400);
    expect(r.noSource!.status).toBe(400);
    expect(r.noSource!.body.error).toBe("source is required: search, fingerprints, push, http, tcp or cert");
    expect(r.noSearch!.status).toBe(404);
    expect(r.fpResolved!.status).toBe(400);
    expect(r.fpResolved!.body.error).toBe("a new-fingerprints monitor does not resolve, so it has no resolved body");
    expect(r.badResolved!.status).toBe(400);
    expect(r.badResolved!.body.error).toBe("the resolved body: {{mark.kind}} is not a fill-in for this alert");
    expect(r.withResolved!.status).toBe(201);
    expect(r.withResolved!.body.resolved_body).toBe("{{alert.name}} resolved after {{duration}}");
  });

  test("two monitors of one name cannot be replaced by name", () => {
    expect(r.dupA!.status).toBe(201);
    expect(r.dupB!.status).toBe(201);
    expect(r.dupPut!.status).toBe(409);
  });

  test("is read and deleted by name", () => {
    expect(r.one!.status).toBe(200);
    expect(r.one!.body).toMatchObject({ name: "ci-box went quiet", stretches: [] });
    expect(r.delete!.status).toBe(200);
    expect(r.gone!.status).toBe(404);
  });
});

describe("GET /api/monitors (#175)", () => {
  test("lists every monitor with its state, and the window's stretches and calls", () => {
    expect(r.monitors!.status).toBe(200);
    const body = r.monitors!.body;
    expect(Object.keys(body).sort()).toEqual(["from", "link", "monitors", "now", "results", "sent", "sources", "stretches", "to"]);
    // No link yet: no source lists monitors here (#333).
    expect(body.sources).toEqual([]);
    expect(body.monitors.map((m: { name: string }) => m.name).sort()).toEqual(["api errors", "ci-box went quiet", "ntfy"]);
    expect(Date.parse(body.to) - Date.parse(body.from)).toBe(24 * 60 * 60_000);
    expect(Date.parse(r.monitors7d!.body.to) - Date.parse(r.monitors7d!.body.from)).toBe(7 * 24 * 60 * 60_000);
    expect(r.monitorsHunt!.body.from).toBe("2026-10-19T11:03:00.000Z");
    expect(r.monitorsBad!.status).toBe(400);
  });
});

describe("HTTP(S) monitors (#178)", () => {
  test("are declared by name, their lines stored as written, a warn line marked at its end", () => {
    expect(r.httpDeclare!.status).toBe(201);
    expect(r.httpDeclare!.body).toMatchObject({ name: "api-health", source: "http", state: "ok", remind_every: "4h", saved: null });
    expect(r.httpDeclare!.body.http).toMatchObject({
      url: "https://api.example.com/health",
      method: "GET",
      every: "30s",
      every_ms: 30_000,
      conditions: "status == 200\ntime < 300ms   warn",
      fail_after: 2,
      headers: ["Authorization"],
      last_run: null,
    });
    expect(r.httpCreate!.status).toBe(201);
    expect(r.httpCreate!.body).toMatchObject({ name: "made in the dialog", source: "http" });
  });

  test("a header's value is never shown back, and null keeps it", () => {
    expect(JSON.stringify(r.httpDeclare!.body)).not.toContain("s3cret");
    expect(r.httpListText!.status).toBe(200);
    expect(r.httpListText!.body).toContain("api-health");
    expect(r.httpListText!.body).not.toContain("s3cret");
    expect(r.httpKeep!.status).toBe(200);
    expect(r.httpOne!.body.http.headers).toEqual(["Authorization"]);
    expect(r.httpOne!.body.enabled).toBe(0);
    // The editor's Send uses the stored value for a header it gives as null.
    expect(JSON.parse(r.httpSendKept!.body.response.body).auth).toBe("Bearer s3cret");
  });

  test("says what is wrong, by line", () => {
    expect(r.httpBadLine!.status).toBe(400);
    expect(r.httpBadLine!.body.error).toStartWith("conditions line 2: not a condition");
    expect(r.httpBadEvery!.body.error).toStartWith("every must be 30s … 1h");
    expect(r.httpWindow!.body.error).toBe("remind_every must be off, 1h, 4h or 24h");
    expect(r.httpNoUrl!.body.error).toBe("url must be an http(s) URL");
    expect(r.httpClash!.status).toBe(400);
    expect(r.httpClash!.body.error).toBe("api-health is an HTTP(S) monitor; delete it to make a search monitor of that name");
    // Without a webhook of its own it calls the default in Settings.
    expect(r.httpNoHook!.status).toBe(201);
    expect(r.httpNoHook!.body).toMatchObject({ webhook_url: null, query: "monitor:no-hook", source: "http" });
    expect(r.httpBadHook!.body.error).toBe("webhook_url must be http(s), or null for the default");
  });

  test("Send runs it once and says what each line makes of the response", () => {
    expect(r.httpSend!.status).toBe(200);
    const sent = r.httpSend!.body;
    expect(sent.response).toMatchObject({ status: 200, status_text: "OK", http_version: "HTTP/1.1" });
    expect(sent.error).toBeNull();
    expect(sent.cert).toBeNull();
    expect(Object.keys(sent.timings).sort()).toEqual(["body", "connect", "dns", "tls", "total", "wait"]);
    expect(sent.verdict).toMatchObject({
      result: "fail",
      line: '$.db == "ok"',
      why: '$.db is "down", not "ok"',
      lines: [{ text: '$.db == "ok"', level: "fail", pass: false, got: '"down"' }],
    });
    expect(r.httpSendBad!.status).toBe(400);
    expect(r.httpSendBadLine!.status).toBe(400);
  });

  test("a test call is filled in from the last Send, then sends its resolved body", () => {
    expect(r.httpTestCall!.status).toBe(200);
    expect(r.httpTestCall!.body).toMatchObject({ ok: true, status: 200, reply: "queued" });
    expect(r.httpTestCall!.body.resolved).toMatchObject({ ok: true, status: 200 });
    const sent = (r.hooked as unknown as Array<{ url: string; body: string }>).map((h) => h.body);
    expect(sent).toEqual(["api-health open: status is 503, not 2xx (503)", "api-health resolved"]);
    expect(r.httpTestCallBad!.status).toBe(400);
    expect(r.httpTestCallBad!.body.error).toBe("{{series}} is not a fill-in for this alert");
  });

  test("delete takes it and what it calls", () => {
    expect(r.httpDelete!.status).toBe(200);
    expect(r.httpGone!.status).toBe(404);
  });
});

describe("TCP and certificate monitors (#180)", () => {
  test("are declared by name, a certificate monitor with its STARTTLS", () => {
    expect(r.tcpDeclare!.status).toBe(201);
    expect(r.tcpDeclare!.body).toMatchObject({ name: "db-port", source: "tcp", state: "ok", query: "monitor:db-port", http: null });
    expect(r.tcpDeclare!.body.net).toMatchObject({
      target: "db.internal:5432",
      starttls: null,
      every: "1m",
      conditions: "connected\ntime < 200ms   warn",
      fail_after: 2,
      last_run: null,
    });
    expect(r.certDeclare!.status).toBe(201);
    expect(r.certDeclare!.body).toMatchObject({ name: "mail-cert", source: "cert" });
    expect(r.certDeclare!.body.net).toMatchObject({
      target: "smtp.agental.dev:587",
      starttls: "smtp",
      every: "1h",
      conditions: "cert > 14d\ncert name == smtp.agental.dev",
    });
    expect(r.certUpdate!.status).toBe(200);
    expect(r.certOne!.body.net).toMatchObject({ target: "imap.agental.dev:993", starttls: null, conditions: "cert > 14d\ncert name == smtp.agental.dev" });
    expect(r.tcpCreate!.status).toBe(201);
    expect(r.tcpCreate!.body).toMatchObject({ name: "tcp from the dialog", source: "tcp" });
    const listed = r.netList!.body.monitors as Array<{ name: string; net: unknown }>;
    expect(listed.find((m) => m.name === "mail-cert")?.net).toMatchObject({ target: "imap.agental.dev:993" });
  });

  test("each reads its own lines, and says what is wrong", () => {
    expect(r.tcpBadLine!.status).toBe(400);
    expect(r.tcpBadLine!.body.error).toBe("conditions line 1: not a TCP condition: connected, time < 200ms");
    expect(r.certBadLine!.body.error).toBe("conditions line 1: not a certificate condition: connected, time < 200ms, cert > 14d, cert name == mail.example.com");
    expect(r.tcpBadTarget!.body.error).toBe("target is host:port, without a scheme or a path");
    expect(r.tcpNoPort!.body.error).toBe("target is host:port: db.internal:5432, or [::1]:993");
    expect(r.tcpStarttls!.body.error).toBe("starttls is for a certificate monitor; a TCP monitor only connects");
    expect(r.certBadStarttls!.body.error).toBe("starttls must be smtp, imap or pop3, or null for TLS from the first byte");
    expect(r.netClash!.status).toBe(400);
    expect(r.netClash!.body.error).toBe("db-port is a TCP monitor; delete it to make a certificate monitor of that name");
    expect(r.netClashSearch!.body.error).toBe("mail-cert is a certificate monitor; delete it to make a search monitor of that name");
  });

  test("Send connects once and says what each line makes of it", () => {
    expect(r.tcpSend!.status).toBe(200);
    const sent = r.tcpSend!.body;
    expect(sent).toMatchObject({ source: "tcp", connected: true, address: "127.0.0.1", error: null, cert: null });
    expect(Object.keys(sent.timings).sort()).toEqual(["connect", "dns", "starttls", "tls", "total"]);
    expect(sent.verdict.result).toBe("ok");
    expect(sent.verdict.lines.map((l: { text: string; pass: boolean }) => [l.text, l.pass])).toEqual([
      ["connected", true],
      ["time < 5000ms", true],
    ]);
    expect(r.tcpSendBad!.status).toBe(400);
  });

  test("a test call is filled in from the last Send, with its own fill-ins", () => {
    expect(r.certTestCall!.status).toBe(200);
    const sent = (r.netHooked as unknown as Array<{ body: string }>).map((h) => h.body);
    expect(sent).toEqual(["mail-cert open: certificate expires in 6 days (smtp.agental.dev:587)"]);
    expect(r.certTestCallBad!.body.error).toBe("{{url}} is not a fill-in for this alert");
  });

  test("delete takes it and where it connects", () => {
    expect(r.tcpDelete!.status).toBe(200);
    expect(r.tcpGone!.status).toBe(404);
  });
});
