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
    // #334: a region pulls edge-fra, 4 minutes behind, and serves prod-eu; prod-eu's link from the region heard so.
    const t = Date.now();
    saveLink({ ...base, id: "fromEdge", role: "pull", peer_name: "edge-fra", q: "", kid: "k4" });
    noteContact("fromEdge", { at: t - 2000, position: 50, settled: 90, arrived_at: new Date(t - 240000).toISOString() });
    saveLink({ ...base, id: "toCentre", role: "serve", peer_name: "prod-eu", q: "", kid: "k5" });
    saveLink({ ...base, id: "fromRegion", role: "pull", peer_name: "region-eu", q: "", kid: "k6" });
    noteContact("fromRegion", { at: t - 2000, position: 9, settled: 9, upstream: JSON.stringify([{ name: "edge-fra", filters: [], state: { kind: "behind", readTo: t - 240000 }, hole: null }]) });
    out.edgePull = await req("/api/links/fromEdge");
    out.regionServe = await req("/api/links/toCentre");
    out.centrePull = await req("/api/links/fromRegion");
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

describe("a source two hops away (#334)", () => {
  type Further = Array<{ name: string; state: { kind: string }; behind_ms: number }>;
  test("the region's link from the edge says how far behind the edge is, in time", () => {
    expect(out.edgePull!.body.behind_ms as number).toBeGreaterThanOrEqual(240_000);
    expect(out.edgePull!.body.further).toEqual([]);
  });
  test("the region's link to the centre says what it tells the centre: the edge, behind; never the centre itself", () => {
    // Every source this side pulls from goes; here the other tests' links too.
    const further = out.regionServe!.body.further as Further;
    const edge = further.find((f) => f.name === "edge-fra")!;
    expect(edge.state.kind).toBe("behind");
    expect(edge.behind_ms).toBeGreaterThanOrEqual(240_000);
    expect(further.some((f) => f.name === "prod-eu")).toBe(false);
    expect(out.regionServe!.body.behind_ms).toBeNull();
  });
  test("the centre's link from the region names the edge further away, as the region said", () => {
    const further = out.centrePull!.body.further as Further;
    expect(further.map((f) => [f.name, f.state.kind])).toEqual([["edge-fra", "behind"]]);
    expect(out.centrePull!.body.behind_ms).toBe(0);
  });
});
