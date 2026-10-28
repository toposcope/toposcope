// Three instances chained edge → region → centre, plus a direct edge → centre link (#334): run
// against three apps on one machine, each with its own ClickHouse database and SQLite file.
// TOPOSCOPE_TOKEN_EDGE, _REGION and _CENTRE are an Owner token on each.
//   TIERS_EDGE_URL=… TIERS_REGION_URL=… TIERS_CENTRE_URL=… bun run scripts/tiers-e2e.ts
const EDGE = process.env.TIERS_EDGE_URL ?? "http://127.0.0.1:28085";
const REGION = process.env.TIERS_REGION_URL ?? "http://127.0.0.1:28090";
const CENTRE = process.env.TIERS_CENTRE_URL ?? "http://127.0.0.1:28080";
const ingestToken = process.env.TOPOSCOPE_INGEST_TOKEN ?? "";
const tag = Date.now().toString(36);
const tokens: Record<string, string> = {
  [EDGE]: process.env.TOPOSCOPE_TOKEN_EDGE ?? "",
  [REGION]: process.env.TOPOSCOPE_TOKEN_REGION ?? "",
  [CENTRE]: process.env.TOPOSCOPE_TOKEN_CENTRE ?? "",
};

async function call(base: string, path: string, init: RequestInit & { json?: unknown } = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${tokens[base] ?? ""}`, "content-type": "application/json", ...(init.headers ?? {}) },
    body: init.json === undefined ? init.body : JSON.stringify(init.json),
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

function check(ok: boolean, what: string, got?: unknown): void {
  if (!ok) throw new Error(`${what}${got === undefined ? "" : `: ${JSON.stringify(got).slice(0, 400)}`}`);
  console.log(`ok · ${what}`);
}

async function until(what: string, test: () => Promise<boolean>, seconds = 45): Promise<void> {
  for (let i = 0; i < seconds * 2; i++) {
    if (await test()) {
      console.log(`ok · ${what}`);
      return;
    }
    await Bun.sleep(500);
  }
  throw new Error(`timed out: ${what}`);
}

async function name(base: string, wanted: string): Promise<string> {
  const current = await call(base, "/api/settings");
  if (current.body?.instance_name) return current.body.instance_name;
  const res = await call(base, "/api/settings", { method: "PUT", json: { instance_name: wanted } });
  check(res.status === 200, `name ${base} ${wanted}`, res.body);
  return wanted;
}

async function link(from: string, to: string, what: string): Promise<void> {
  const offer = await call(from, "/api/links/offer", { method: "POST", json: { q: "" } });
  check(offer.status === 201, `${what}: the source mints an every-row key`, offer.body);
  const confirm = await call(to, "/api/links/confirm", { method: "POST", json: { key: offer.body.key } });
  check(confirm.status === 201 && confirm.body.role === "pull", `${what}: the puller pastes it`, confirm.body);
}

async function send(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${EDGE}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${ingestToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  check(res.ok, `the edge takes ${path}`);
}

const nEdge = await name(EDGE, "edge-fra");
const nRegion = await name(REGION, "region-eu");
await name(CENTRE, "prod-eu");
await link(EDGE, REGION, "edge → region");
await link(REGION, CENTRE, "region → centre");
await link(EDGE, CENTRE, "edge → centre, direct");

const service = `tier-${tag}`;
const nano = `${Date.now()}000000`;
const traceId = crypto.randomUUID().replaceAll("-", "");
const resource = { attributes: [{ key: "service.name", value: { stringValue: service } }] };
// The check below writes a log row of its own (every result is one), so the ingested row has a word of its own.
await send("/api/ingest", [{ service, level: "error", message: `${tag} ingestedrow at the edge` }]);
await send("/v1/traces", { resourceSpans: [{ resource, scopeSpans: [{ spans: [{ traceId, spanId: "1f067aa0ba902b71", name: "GET /tier", kind: 2, startTimeUnixNano: nano, endTimeUnixNano: nano, status: {} }] }] }] });
await send("/v1/metrics", { resourceMetrics: [{ resource, scopeMetrics: [{ metrics: [{ name: `tier.req.${tag}`, unit: "1", gauge: { dataPoints: [{ timeUnixNano: nano, asDouble: 3 }] } }] }] }] });
await send("/v1/checks", { monitor: `tier-${tag}`, status: "fail", message: "edge down", service, host: "edge-host" });

const total = async (base: string, q: string) => Number((await call(base, `/api/search?${new URLSearchParams({ q, range: "15m", events: "0" })}`)).body?.total ?? -1);
await until("the region holds the edge's row, under the edge's name", async () => (await total(REGION, `toposcope:${nEdge} service:${service} ingestedrow`)) === 1);
await until("the centre holds it once, though it came two ways, under the edge's name", async () => (await total(CENTRE, `toposcope:${nEdge} service:${service} ingestedrow`)) === 1);
// Give the second route time to deliver too, then check again: still once.
await Bun.sleep(12_000);
check((await total(CENTRE, `service:${service} ingestedrow`)) === 1, "still once at the centre after both routes have run");
check((await total(CENTRE, `toposcope:${nRegion} service:${service}`)) === 0, "never under the region's name");
await until("the centre holds the edge's span once, under the edge's name", async () => {
  const t = await call(CENTRE, `/api/traces/${traceId}`);
  return t.status === 200 && t.body.spans?.length === 1 && t.body.spans[0].toposcope === nEdge;
});
await until("the centre holds the edge's metric point", async () => JSON.stringify((await call(CENTRE, "/api/metric-names?range=15m")).body).includes(`tier.req.${tag}`));
await until("the centre lists the edge's monitor under the edge's name, not the region's", async () => {
  const w = await call(CENTRE, "/api/monitors?range=24h");
  const sources = (w.body.sources ?? []) as Array<{ source: string; monitors: Array<{ name: string }> }>;
  const at = (s: string) => sources.find((x) => x.source === s)?.monitors.some((m) => m.name === `tier-${tag}`) ?? false;
  return at(nEdge) && !at(nRegion);
});
console.log("tiers e2e ok");

export {};
