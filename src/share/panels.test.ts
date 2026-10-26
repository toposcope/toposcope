import { beforeAll, describe, expect, test } from "bun:test";
import { deriveShareScope, panelReadParams, parseSharePanels, rawParamsUsed, scopeGaps, type SharePanel } from "./panels";
import { parseShareScope, type ShareScope } from "./scope";

const panels = parseSharePanels([
  { name: "latency-p99", params: { chart: "line", metric: "p99:fleet_latency", ml: "service:agental,host:ovh-01", split: "host", range: "24h" }, from: "the Ops board" },
  { name: "errors-by-level", params: { chart: "line", agg: "count", split: "level", range: "7d" } },
  { name: "top-pools", params: { chart: "donut", key: "pool", n: "5" } },
]) as SharePanel[];

describe("named panels on a share (#266, 26k)", () => {
  test("a panel is the tag's own params, named; anything else is refused", () => {
    expect(panels.length).toBe(3);
    expect(panels[0]!.from).toBe("the Ops board");
    expect(parseSharePanels([{ name: "Bad Name", params: {} }])).toEqual({ error: "panel name Bad Name: lower-case letters, digits, . _ -, up to 48" });
    expect(parseSharePanels([{ name: "a", params: { q: "service:x" } }])).toEqual({ error: "panel a: q is not a panel param" });
    expect(parseSharePanels([{ name: "a", params: { chart: "top" } }])).toEqual({ error: "panel a: a top or donut panel names its key" });
    expect(parseSharePanels([{ name: "a", params: {} }, { name: "a", params: {} }])).toEqual({ error: "two panels are named a" });
  });
  test("the fence is derived from the panels; logs keep the q given", () => {
    expect(deriveShareScope(panels, "service:agental")).toEqual({
      metric_names: ["fleet_latency"],
      metric_labels: { service: "agental", host: "ovh-01" },
      logs: "service:agental",
      split: ["host", "level", "pool"],
      narrow: [],
    });
    expect(deriveShareScope(panels, null)).toEqual({ error: "a log panel reads the share's logs: give scope.logs (a q) or logs" });
  });
  test("a given scope must cover the panels", () => {
    const narrow = parseShareScope({ metric_names: ["fleet_cpu_*"], logs: null, split: ["host"] }) as ShareScope;
    expect(scopeGaps(narrow, panels)).toEqual([
      "panel latency-p99 reads fleet_latency, outside metric_names",
      "panel errors-by-level reads logs, and the scope reads none",
      "panel errors-by-level splits by level, outside split",
      "panel top-pools reads logs, and the scope reads none",
      "panel top-pools splits by pool, outside split",
    ]);
  });
  test("a read with panel= uses the panel's params; the page moves only the window", () => {
    expect(panelReadParams(panels[0]!, (k) => ({ range: "1h", metric: "other" })[k])).toEqual({
      chart: "line", metric: "p99:fleet_latency", ml: "service:agental,host:ovh-01", split: "host", range: "1h",
    });
    expect(rawParamsUsed({ panel: "x", range: "1h" })).toEqual([]);
    expect(rawParamsUsed({ panel: "x", metric: "y", split: "host" })).toEqual(["metric", "split"]);
  });
});

let reads: Record<string, { status: number; body: Record<string, unknown> }>;

beforeAll(() => {
  // A child process keeps this SQLite out of the other tests; reads go to the ClickHouse the suite uses.
  const script = `
    const root = ${JSON.stringify(import.meta.dir)} + "/..";
    const { Hono } = await import("hono");
    const { shareAuth } = await import(root + "/share/operator.ts");
    const { shareSeriesRoute, sharePanelRoute } = await import(root + "/share/read.ts");
    const { putShare } = await import(root + "/share/store.ts");
    const { parseShareScope } = await import(root + "/share/scope.ts");
    const { defaultShareLimits } = await import(root + "/share/limits.ts");
    const { defaultShareEmbed } = await import(root + "/share/embed.ts");
    const app = new Hono();
    app.use("/share/*", shareAuth);
    app.get("/share/v1/series", shareSeriesRoute);
    app.get("/share/v1/panels/:name", sharePanelRoute);
    const scope = parseShareScope({ metric_names: [], logs: "service:panels-test", split: ["level"] });
    const base = { scope, limits: defaultShareLimits, embed: defaultShareEmbed, expires_at: Date.now() + 86400000 };
    const panels = [{ name: "errors", params: { chart: "line", agg: "count", split: "level", range: "1h" } }];
    const on = putShare({ ...base, name: "panels-on", panels, raw_params: true }).secret;
    const off = putShare({ ...base, name: "panels-off", panels, raw_params: false }).secret;
    const get = async (secret, path) => { const r = await app.request(path, { headers: { authorization: "Bearer " + secret } }); return { status: r.status, body: await r.json() }; };
    const out = {
      panelOn: await get(on, "/share/v1/series?panel=errors"),
      rawOn: await get(on, "/share/v1/series?agg=count&range=1h"),
      panelOff: await get(off, "/share/v1/series?panel=errors&range=15m"),
      rawOff: await get(off, "/share/v1/series?agg=count&range=1h"),
      mixedOff: await get(off, "/share/v1/series?panel=errors&split=none"),
      missing: await get(on, "/share/v1/series?panel=nope"),
      def: await get(off, "/share/v1/panels/errors"),
    };
    console.log(JSON.stringify(out));
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", script], {
    env: { ...process.env, SQLITE_PATH: ":memory:" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (child.exitCode !== 0) {
    throw new Error(child.stderr.toString());
  }
  reads = JSON.parse(child.stdout.toString().trim().split("\\n").at(-1)!);
});

describe("reading a named panel through a share (#266)", () => {
  test("panel= reads; raw params read while the switch is on", () => {
    expect(reads.panelOn!.status).toBe(200);
    expect(reads.panelOn!.body.agg).toBe("count");
    expect(reads.rawOn!.status).toBe(200);
  });
  test("with the switch off, a panel and a window read; raw params and extras are refused", () => {
    expect(reads.panelOff!.status).toBe(200);
    expect(reads.rawOff!.status).toBe(400);
    expect(String(reads.rawOff!.body.error)).toContain("named panels only");
    expect(reads.mixedOff!.status).toBe(400);
    expect(String(reads.mixedOff!.body.error)).toContain("not split");
    expect(reads.missing!.status).toBe(404);
  });
  test("the embed reads a panel's definition", () => {
    expect(reads.def!.body).toEqual({ name: "errors", params: { chart: "line", agg: "count", split: "level", range: "1h" }, raw_params: false });
  });
});
