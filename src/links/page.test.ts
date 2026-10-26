import { beforeAll, describe, expect, test } from "bun:test";

let out: Record<string, { status: number; body: Record<string, unknown> }>;

beforeAll(() => {
  // A child process keeps this SQLite out of the other tests.
  const script = `
    const root = ${JSON.stringify(import.meta.dir)} + "/..";
    const { Hono } = await import("hono");
    const { saveLink } = await import(root + "/links/store.ts");
    const { linkPageRoute, updateLinkRoute, isPaused } = await import(root + "/links/page.ts");
    const app = new Hono();
    app.get("/api/links/:id", linkPageRoute);
    app.put("/api/links/:id", updateLinkRoute);
    const base = { connects: "we", peer_id: "p", peer_url: "http://10.0.0.1:8080", kid: "k1", secret: null, secret_hash: null, created_at: 1 };
    saveLink({ ...base, id: "pull1", role: "pull", peer_name: "ci-box", q: "service:ci*" });
    saveLink({ ...base, id: "serve1", role: "serve", peer_name: "ian-laptop", q: "level:error", kid: "k2" });
    const req = async (path, init) => { const r = await app.request(path, init); return { status: r.status, body: await r.json() }; };
    const put = (id, body) => req("/api/links/" + id, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const out = {
      page: await req("/api/links/pull1"),
      missing: await req("/api/links/nope"),
      paused: await put("pull1", { paused: true }),
      pullScope: await put("pull1", { q: "service:other" }),
      serveScope: await put("serve1", { q: "level:fatal" }),
      badScope: await put("serve1", { q: "(" }),
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
