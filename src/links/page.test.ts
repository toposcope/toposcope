import { beforeAll, describe, expect, test } from "bun:test";

let out: Record<string, { status: number; body: Record<string, unknown> }>;

beforeAll(() => {
  // A child process keeps this SQLite out of the other tests.
  const script = `
    const root = ${JSON.stringify(import.meta.dir)} + "/..";
    const { Hono } = await import("hono");
    const { saveLink, noteContact, noteVolume } = await import(root + "/links/store.ts");
    const { linkPageRoute, updateLinkRoute, isPaused } = await import(root + "/links/page.ts");
    const app = new Hono();
    app.get("/api/links/:id", linkPageRoute);
    app.put("/api/links/:id", updateLinkRoute);
    const base = { connects: "we", peer_id: "p", peer_url: "http://10.0.0.1:8080", kid: "k1", secret: null, secret_hash: null, created_at: 1 };
    saveLink({ ...base, id: "pull1", role: "pull", peer_name: "ci-box", q: "service:ci*" });
    saveLink({ ...base, id: "serve1", role: "serve", peer_name: "ian-laptop", q: "level:error", kid: "k2" });
    saveLink({ ...base, id: "kinds1", role: "serve", peer_name: "edge-1", q: "level:error", kid: "k3", kinds: "logs,marks,traces,metrics,monitors" });
    noteContact("kinds1", { at: 2, kind_state: JSON.stringify({ spans: { not_sent: "the filter names level" }, metrics: { gone: { from: 1, to: 9 } } }) });
    noteVolume("kinds1", "logs", 120, 6000);
    noteVolume("kinds1", "metrics", 900, 30000);
    noteVolume("kinds1", "metric_buckets", 100, 2000);
    const req = async (path, init) => { const r = await app.request(path, init); return { status: r.status, body: await r.json() }; };
    const put = (id, body) => req("/api/links/" + id, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const out = {
      page: await req("/api/links/pull1"),
      missing: await req("/api/links/nope"),
      paused: await put("pull1", { paused: true }),
      pullScope: await put("pull1", { q: "service:other" }),
      serveScope: await put("serve1", { q: "level:fatal" }),
      badScope: await put("serve1", { q: "(" }),
      kindsPage: await req("/api/links/kinds1"),
      untick: await put("kinds1", { kinds: ["logs", "marks", "traces", "metrics"] }),
      widen: await put("kinds1", { kinds: ["logs", "marks", "profiles"] }),
      pullKinds: await put("pull1", { kinds: ["logs"] }),
      widenWithScope: await put("kinds1", { q: "level:warn", kinds: ["logs", "profiles"] }),
      afterRefusal: await req("/api/links/kinds1"),
    };
    out.pausedFlag = { status: 0, body: { paused: isPaused({ id: "pull1" }) } };
    console.log(JSON.stringify(out));
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", script], {
    env: { ...process.env, SQLITE_PATH: ":memory:", CLICKHOUSE_URL: "http://127.0.0.1:9" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (child.exitCode !== 0) {
    throw new Error(child.stderr.toString());
  }
  out = JSON.parse(child.stdout.toString().trim().split("\\n").at(-1)!);
});

describe("a link's page (#267, 26m)", () => {
  test("its facts; a link that is gone is 404", () => {
    expect(out.page!.status).toBe(200);
    expect(out.page!.body).toMatchObject({ role: "pull", peer: "ci-box", q: "service:ci*", paused: false, scope_here: false, pulled: [], pulled_24h: 0 });
    expect(out.missing!.status).toBe(404);
  });
  test("pause keeps the link; the puller skips it", () => {
    expect(out.paused!.body.paused).toBe(true);
    expect(out.pausedFlag!.body.paused).toBe(true);
  });
  test("a new scope only where rows leave here", () => {
    expect(out.pullScope!.status).toBe(409);
    expect(out.serveScope!.status).toBe(200);
    expect(out.serveScope!.body.q).toBe("level:fatal");
    expect(out.badScope!.status).toBe(400);
  });
});

describe("a link says which kinds it carries (#329, 33b)", () => {
  const line = (kind: string) => (out.kindsPage!.body.kinds as Array<Record<string, unknown>>).find((l) => l.kind === kind)!;
  test("a line per kind, on the one position: its state, why one is not sent, and rows and bytes a day", () => {
    expect((out.kindsPage!.body.kinds as unknown[]).length).toBe(6);
    expect(line("logs")).toMatchObject({ ticked: true, state: "caught up", rows_day: 120, bytes_day: 6000 });
    expect(line("traces")).toMatchObject({ ticked: true, state: "not sent", not_sent: "the filter names level" });
    expect(line("metrics")).toMatchObject({ ticked: true, state: "a hole", rows_day: 1000, bytes_day: 32000 });
    expect(line("profiles")).toMatchObject({ ticked: false, state: "unticked at the source" });
  });
  test("where rows leave here a kind can be unticked, never added; the other side cannot change them", () => {
    expect(out.untick!.status).toBe(200);
    expect(out.widen!.status).toBe(409);
    expect(out.widen!.body.error).toBe("A kind is never added to a key already used: to send it too, make a new key");
    expect(out.pullKinds!.status).toBe(409);
    // A refused change saves nothing, not even the scope it came with.
    expect(out.widenWithScope!.status).toBe(409);
    expect(out.afterRefusal!.body.q).toBe("level:error");
  });
});
