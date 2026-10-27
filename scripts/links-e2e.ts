// Two instances linked both ways (#136): run against two apps on one machine, each with its own
// ClickHouse database and SQLite file. TOPOSCOPE_TOKEN_A and TOPOSCOPE_TOKEN_B are an Owner token on
// each (`toposcope.sh service-token`, or `bun run src/cli.ts service-token e2e owner` with its SQLITE_PATH).
//   LINKS_A_URL=http://127.0.0.1:28080 LINKS_B_URL=http://127.0.0.1:28085 bun run scripts/links-e2e.ts
const A = process.env.LINKS_A_URL ?? "http://127.0.0.1:28080";
const B = process.env.LINKS_B_URL ?? "http://127.0.0.1:28085";
const ingestToken = process.env.TOPOSCOPE_INGEST_TOKEN ?? "";
const tag = Date.now().toString(36);
const tokens: Record<string, string> = { [A]: process.env.TOPOSCOPE_TOKEN_A ?? "", [B]: process.env.TOPOSCOPE_TOKEN_B ?? "" };

async function call(base: string, path: string, init: RequestInit & { json?: unknown } = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${tokens[base] ?? ""}`, "content-type": "application/json", ...(init.headers ?? {}) },
    body: init.json === undefined ? init.body : JSON.stringify(init.json),
  });
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body };
}

function check(ok: boolean, what: string, got?: unknown): void {
  if (!ok) {
    throw new Error(`${what}${got === undefined ? "" : `: ${JSON.stringify(got).slice(0, 400)}`}`);
  }
  console.log(`ok · ${what}`);
}

async function ingest(base: string, service: string, rows: Array<{ level: string; message: string }>): Promise<void> {
  const res = await fetch(`${base}/api/ingest`, {
    method: "POST",
    headers: { authorization: `Bearer ${ingestToken}`, "content-type": "application/json" },
    body: JSON.stringify(rows.map((r) => ({ service, ...r }))),
  });
  check(res.ok, `ingest on ${base}`);
}

async function count(base: string, q: string): Promise<number> {
  const params = new URLSearchParams({ q, range: "15m", events: "0" });
  const res = await call(base, `/api/search?${params}`);
  return Number(res.body?.total ?? -1);
}

async function until(what: string, test: () => Promise<boolean>, seconds = 30): Promise<void> {
  for (let i = 0; i < seconds * 2; i++) {
    if (await test()) {
      console.log(`ok · ${what}`);
      return;
    }
    await Bun.sleep(500);
  }
  throw new Error(`timed out: ${what}`);
}

async function nameInstance(base: string, wanted: string): Promise<string> {
  const current = await call(base, "/api/settings");
  if (current.body?.instance_name) {
    return current.body.instance_name;
  }
  const res = await call(base, "/api/settings", { method: "PUT", json: { instance_name: wanted } });
  check(res.status === 200, `name ${base} ${wanted}`, res.body);
  return wanted;
}

const nameA = await nameInstance(A, "prod-eu");
const nameB = await nameInstance(B, "edge-fra");
const service = `linked-${tag}`;

// 1. A offers its errors; B pastes and pulls.
const offer = await call(A, "/api/links/offer", { method: "POST", json: { q: "level:error" } });
check(offer.status === 201 && offer.body.key.startsWith("tsl2_o."), "A mints an offer key", offer.body);
const preview = await call(B, "/api/links/preview", { method: "POST", json: { key: offer.body.key } });
check(
  preview.status === 200 && preview.body.kind === "offer" && preview.body.name === nameA && preview.body.q === "level:error" && preview.body.lookup?.state === "unused",
  "B's preview names the minter, the direction and the filter, checked with A",
  preview.body,
);
check(!("secret" in preview.body), "the preview never shows the key's secret");
const confirm = await call(B, "/api/links/confirm", { method: "POST", json: { key: offer.body.key } });
check(confirm.status === 201 && confirm.body.role === "pull" && confirm.body.peer_name === nameA, "B confirms: a link pulling from A", confirm.body);

await ingest(A, service, [
  { level: "error", message: `${tag} e1` },
  { level: "info", message: `${tag} i1` },
  { level: "error", message: `${tag} e2` },
  { level: "error", message: `${tag} e3` },
  { level: "info", message: `${tag} i2` },
]);
await until("B holds exactly A's three errors, named prod-eu", async () => (await count(B, `service:${service}`)) === 3);
check((await count(B, `toposcope:${nameA} service:${service}`)) === 3, "B finds them by toposcope:prod-eu, on the rollups");

// 2. The key is spent; a malformed one is not a key.
const spent = await call(B, "/api/links/preview", { method: "POST", json: { key: offer.body.key } });
check(spent.body.lookup?.state === "used", "the offer key is spent after one paste", spent.body);
const reuse = await call(B, "/api/links/confirm", { method: "POST", json: { key: offer.body.key } });
check(reuse.status === 409, "pasting it again is refused", reuse.body);
const malformed = await call(B, "/api/links/preview", { method: "POST", json: { key: "Bearer 9f2c1e7a0b44d6" } });
check(malformed.status === 400 && malformed.body.error === "Not a link key.", "a malformed key is not a link key", malformed.body);

// 3. The other way: B offers every row to A. Rows B pulled from A do not come back to A.
const back = await call(B, "/api/links/offer", { method: "POST", json: { q: "" } });
const backConfirm = await call(A, "/api/links/confirm", { method: "POST", json: { key: back.body.key } });
check(backConfirm.status === 201, "A pulls every row from B", backConfirm.body);
await ingest(B, service, [{ level: "warn", message: `${tag} from edge` }]);
await until("A holds B's own row", async () => (await count(A, `toposcope:${nameB} service:${service}`)) === 1);
await Bun.sleep(6_000);
check((await count(A, `service:${service}`)) === 6, "A holds its own five and B's one: its errors did not come back twice");

// 4. Lists on both sides.
const listA = await call(A, "/api/links");
const listB = await call(B, "/api/links");
const serveOnA = listA.body.links.find((l: any) => l.role === "serve" && l.peer_name === nameB);
const pullOnB = listB.body.links.find((l: any) => l.role === "pull" && l.peer_name === nameA);
check(Boolean(serveOnA) && serveOnA.connects === "they", "A lists B under Pulled from here, B calling", serveOnA);
check(Boolean(pullOnB) && pullOnB.connects === "we" && pullOnB.position >= pullOnB.settled - 0, "B lists A under Pulling into here, caught up", pullOnB);
check(listA.body.links.every((l: any) => !("secret" in l) && !("secret_hash" in l)), "no secret in a list");

// 5. A removes the link it serves: B's next pull is refused, and says so.
const removed = await call(A, `/api/links/${serveOnA.id}`, { method: "DELETE" });
check(removed.status === 200, "A removes the link B pulls through");
await until("B's link says the source refused it", async () => {
  const list = await call(B, "/api/links");
  const link = list.body.links.find((l: any) => l.id === pullOnB.id);
  return typeof link?.last_error === "string" && link.last_error.includes("removed");
});
// 6. A invites a source (#137); B pastes and calls out, so B needs no inbound port.
const invite = await call(A, "/api/links/invite", { method: "POST", json: { q: "level:warn" } });
check(invite.status === 201 && invite.body.key.startsWith("tsl2_i."), "A mints an invite key", invite.body);
const invited = await call(B, "/api/links/confirm", { method: "POST", json: { key: invite.body.key } });
check(invited.status === 201 && invited.body.role === "serve" && invited.body.connects === "we", "B pastes it: rows leave B, B calls A", invited.body);
const warnService = `called-${tag}`;
await ingest(B, warnService, [
  { level: "warn", message: `${tag} w1` },
  { level: "info", message: `${tag} i1` },
  { level: "warn", message: `${tag} w2` },
]);
// A's every-row link from B (step 2) is still on, so B's info row reaches A too; count the warnings.
await until("A holds B's two warnings, once each, as B calls", async () => (await count(A, `toposcope:${nameB} service:${warnService} level:warn`)) === 2);
const pullOnA = (await call(A, "/api/links")).body.links.find((l: any) => l.role === "pull" && l.connects === "they" && l.peer_name === nameB);
check(Boolean(pullOnA) && pullOnA.position > 0 && pullOnA.last_error === null, "A's list: pulling from edge-fra, they call us", pullOnA);
// Each side moves its position after the other answers, so the two agree once a call settles.
await until("B's list: pulled by prod-eu, we call them, at A's position", async () => {
  const a = (await call(A, "/api/links")).body.links.find((l: any) => l.id === pullOnA.id);
  const b = (await call(B, "/api/links")).body.links.find((l: any) => l.id === invited.body.id);
  return Boolean(a && b) && a.position === b.position;
});
// 7. Marks come with a link (#138): B's marks reach A over A's every-row link from B.
async function mark(base: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${base}/v1/marks`, {
    method: "POST",
    headers: { authorization: `Bearer ${ingestToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  check(res.ok, `post mark ${String(body.id)} on ${base}`);
}
const now = Date.now();
const deployId = `deploy-api-${tag}`;
await mark(B, { id: deployId, kind: "deploy", service: "api", title: `v1.4-${tag}`, ts: new Date(now - 3 * 60_000).toISOString() });
await mark(A, { id: deployId, kind: "deploy", service: "api", title: `v1.4-${tag}`, ts: new Date(now - 5 * 60_000).toISOString() });
const incidentId = `inc-${tag}`;
await mark(B, { id: incidentId, kind: "incident", service: "api", title: `checkout down ${tag}`, ts: new Date(now - 2 * 60_000).toISOString() });
const marksOn = async (base: string) =>
  ((await call(base, "/api/marks?range=15m")).body?.marks ?? []) as Array<{ id: string; ts: string; end_ts: string | null; toposcope?: string }>;
await until("B's deploy is on A's lane, under edge-fra", async () => (await marksOn(A)).some((m) => m.id === `${deployId}@${nameB}`));
await mark(B, { id: incidentId, kind: "incident", service: "api", title: `checkout down ${tag}`, ts: new Date(now - 2 * 60_000).toISOString(), end_ts: new Date(now - 60_000).toISOString() });
await until("the incident closed on B closes on A", async () => (await marksOn(A)).some((m) => m.id === `${incidentId}@${nameB}` && m.end_ts !== null));
const both = (await marksOn(A)).filter((m) => m.id === deployId || m.id === `${deployId}@${nameB}`);
check(both.length === 2 && both.find((m) => m.id === `${deployId}@${nameB}`)?.toposcope === nameB, "the same id from two instances stays two marks on A, the pulled one named edge-fra", both);
for (const m of both) {
  const cut = await call(A, `/api/search/cut?mark=${encodeURIComponent(m.id)}&range=15m`);
  check(cut.status === 200 && Date.parse(cut.body.windows.afterFrom) === Date.parse(m.ts), `Fingerprints opens on ${m.id}, cutting at its own time`, cut.body);
}
console.log("links e2e ok");

export {};
