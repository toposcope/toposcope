// The skill's design step (#361), end to end, the way SKILL.md says, through toposcope.sh alone:
// agent → call monitor_draft_preview → monitor_put → home_set → panel_add → undo, with a CI step
// written into a fixture app's workflow file. It starts an app from this checkout on loopback, with
// a SQLite file and a ClickHouse database of its own, and a stand-in docker that runs `src/cli.ts`
// on that SQLite file as `docker compose exec app` would. Needs only ClickHouse:
//   CLICKHOUSE_URL=http://127.0.0.1:8123 CLICKHOUSE_PASSWORD=… bun run scripts/skill-design-e2e.ts
// Too big for CI; run it by hand against a branch that has #357 to #360.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const script = join(root, "skills/toposcope/toposcope.sh");
const skill = readFileSync(join(root, "skills/toposcope/SKILL.md"), "utf8");
const port = Number(process.env.SKILL_E2E_PORT ?? 28391);
const base = `http://127.0.0.1:${port}`;
const clickhouse = new URL(process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123");
const database = process.env.SKILL_E2E_DATABASE ?? "skill_e2e";
const chAuth = `Basic ${btoa(`${process.env.CLICKHOUSE_USER ?? "default"}:${process.env.CLICKHOUSE_PASSWORD ?? ""}`)}`;
const ingestToken = `ingest-${crypto.randomUUID()}`;
const service = "fixture-shop";
const dir = mkdtempSync(join(tmpdir(), "toposcope-skill-e2e-"));
const sqlite = join(dir, "control.sqlite");
/** Everything the script printed, as a person would see it in the transcript. */
let transcript = "";

function check(ok: boolean, what: string, got?: unknown): void {
  if (!ok) {
    throw new Error(`${what}${got === undefined ? "" : `: ${JSON.stringify(got).slice(0, 600)}`}`);
  }
  console.log(`ok · ${what}`);
}

// ---- The instance: an app on loopback, with what `toposcope.sh` expects beside it. ----
const chRoot = new URL(clickhouse.origin);
const created = await fetch(chRoot, { method: "POST", headers: { authorization: chAuth }, body: `CREATE DATABASE IF NOT EXISTS ${database}` });
check(created.ok, `ClickHouse database ${database}`, await created.text());
clickhouse.searchParams.set("database", database);

writeFileSync(join(dir, ".env"), `TOPOSCOPE_INGEST_TOKEN=${ingestToken}\n`, { mode: 0o600 });
writeFileSync(join(dir, "compose.yml"), "services: {}\n");
const bin = join(dir, "bin");
mkdirSync(bin);
writeFileSync(
  join(bin, "docker"),
  [
    "#!/usr/bin/env bash",
    'all="$*"',
    '[ "${all#compose exec -T app bun run src/cli.ts }" != "$all" ] || exit 64',
    "shift 7",
    `cd ${JSON.stringify(root)} && SQLITE_PATH=${JSON.stringify(sqlite)} exec ${JSON.stringify(process.execPath)} run src/cli.ts "$@"`,
    "",
  ].join("\n"),
);
chmodSync(join(bin, "docker"), 0o755);
// curl as it is, with every argument written down, to show no token was in one.
const argvLog = join(dir, "curl-argv.log");
writeFileSync(join(bin, "curl"), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >>${JSON.stringify(argvLog)}\nexec ${JSON.stringify(Bun.which("curl")!)} "$@"\n`);
chmodSync(join(bin, "curl"), 0o755);

const app = Bun.spawn([process.execPath, "run", "src/index.ts"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    SQLITE_PATH: sqlite,
    CLICKHOUSE_URL: clickhouse.toString(),
    TOPOSCOPE_INGEST_TOKEN: ingestToken,
    OTLP_GRPC_PORT: "0",
    SYSLOG_UDP_PORT: "0",
    // A local ClickHouse may have the dev password, which a packaged boot refuses.
    TOPOSCOPE_DEV: "1",
  },
  stdout: Bun.file(join(dir, "app.log")),
  stderr: Bun.file(join(dir, "app.err.log")),
});

async function finish(code: number): Promise<never> {
  app.kill();
  await app.exited;
  if (code === 0 && !process.env.SKILL_E2E_KEEP) {
    rmSync(dir, { recursive: true, force: true });
  } else {
    console.log(`kept ${dir}`);
  }
  process.exit(code);
}

async function sh(args: string[], stdin?: string): Promise<{ code: number; out: string; err: string }> {
  const { TOPOSCOPE_URL: _u, TOPOSCOPE_INGEST_TOKEN: _t, ...inherited } = process.env;
  const child = Bun.spawn(["bash", script, ...args], {
    env: { ...inherited, TOPOSCOPE_DIR: dir, TOPOSCOPE_PORT: String(port), PATH: `${bin}:${process.env.PATH}` },
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  transcript += `$ toposcope.sh ${args.join(" ")}\n${out}${err}`;
  return { code, out, err };
}

/** `toposcope.sh call <tool> -`, as the skill says: the route's answer, from under the fence. */
async function call(tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; data: any }> {
  const { code, out } = await sh(["call", tool, "-"], JSON.stringify(args));
  const rpc = JSON.parse(out);
  const text = rpc.result?.content?.[0]?.text;
  const parsed = text === undefined ? rpc : JSON.parse(text);
  return { ok: code === 0, data: parsed && "note" in parsed && "data" in parsed ? parsed.data : parsed };
}

try {
  for (let i = 0; ; i++) {
    const res = await fetch(`${base}/api/health`).catch(() => null);
    if (res?.ok) break;
    if (i > 240) throw new Error(`the app did not start: see ${dir}/app.err.log`);
    await Bun.sleep(250);
  }
  check(true, `app from this checkout on ${base}`);

  // ---- What the fixture app sent over the last day: requests, a burst of errors, and a deploy. ----
  const now = Date.now();
  const deployAt = now - 3 * 3_600_000;
  const rows: unknown[] = [];
  for (let i = 0; i < 600; i++) {
    const ts = new Date(now - 6 * 3_600_000 + i * 30_000).toISOString();
    rows.push({ ts, service, level: "info", message: "GET /cart", attrs: { duration_ms: 20 + (i % 50), version: "1.4.1" } });
  }
  for (let i = 0; i < 40; i++) {
    const ts = new Date(deployAt + 20 * 60_000 + i * 5_000).toISOString();
    rows.push({
      ts, service, level: "error", message: "charge failed",
      attrs: { version: "1.4.2", "exception.type": "TypeError", "exception.stacktrace": "TypeError: charge failed\n    at charge (/app/src/billing.js:41:9)\n    at checkout (/app/src/api.js:88:5)" },
    });
  }
  for (let i = 0; i < rows.length; i += 400) {
    const ingested = await fetch(`${base}/api/ingest`, { method: "POST", headers: { authorization: `Bearer ${ingestToken}`, "content-type": "application/json" }, body: JSON.stringify(rows.slice(i, i + 400)) });
    if (!ingested.ok) check(false, "ingest", await ingested.text());
  }
  check(true, `ingested ${rows.length} rows for ${service}`);
  const marked = await fetch(`${base}/v1/marks`, {
    method: "POST", headers: { authorization: `Bearer ${ingestToken}`, "content-type": "application/json" },
    body: JSON.stringify({ kind: "deploy", title: "1.4.2", service, id: `deploy-${service}-1.4.2`, ts: new Date(deployAt).toISOString() }),
  });
  check(marked.ok, "a deploy mark three hours ago", await marked.text());
  await Bun.sleep(1500);

  // ---- Connect as the agent. ----
  const made = await sh(["agent", "skill-e2e"]);
  check(made.code === 0 && made.out.includes("Made agent: skill-e2e, an Operator."), "agent skill-e2e: an Operator, its token in a file", made);
  const tokenFile = join(dir, "agent-skill-e2e.token");
  const token = readFileSync(tokenFile, "utf8").trim();
  check(/^tsp1_/.test(token), "the token file holds one token");
  const shown = await sh(["mcp"]);
  check(shown.code === 0 && shown.out.includes(`--header "Authorization: Bearer $(cat -- ${tokenFile})"`), "mcp prints the Claude Code line");
  const json = await sh(["mcp", "--json", join(dir, "mcp.json")]);
  check(json.code === 0 && JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8")).mcpServers.toposcope.url === `${base}/mcp`, "mcp --json writes a client's config");

  // ---- Look first. ----
  const keys = await call("numeric_keys", { q: `service:${service}`, range: "7d" });
  check(keys.ok && JSON.stringify(keys.data).includes("duration_ms"), "numeric_keys finds duration_ms", keys.data);
  const marks = await call("marks", { kind: "deploy", range: "7d" });
  check(marks.ok && JSON.stringify(marks.data).includes("1.4.2"), "marks finds the deploy", marks.data);
  const home = await call("home", {});
  check(home.ok && home.data.saved_id === null, "home: none is marked", home.data);

  // ---- Previews: what each part would have done over the last 7 days. ----
  const errors = { name: `${service} errors`, query: `service:${service} level:error`, range: "15m" };
  const savedPreview = await call("saved_search_preview", { body: errors });
  check(savedPreview.ok, "saved_search_preview", savedPreview.data);
  const savedErrors = await call("saved_search_create", { body: errors });
  check(savedErrors.ok && typeof savedErrors.data.id === "string" && savedErrors.data.undo?.tool === "saved_search_delete", "saved_search_create answers with its undo", savedErrors.data);

  const monitorName = `${service} errors`;
  // A webhook's URL is its credential: it is never shown through a tool, only its host and a handle.
  const secretHook = `https://hooks.example.test/services/${crypto.randomUUID()}`;
  const errorsMonitor = { source: "search", service, saved_search_id: savedErrors.data.id, threshold: 10, window: "5m", webhook_urls: ["default", secretHook] };
  const unpreviewed = await call("monitor_put", { name: monitorName, body: errorsMonitor });
  check(!unpreviewed.ok && JSON.stringify(unpreviewed.data).includes("monitor_draft_preview"), "monitor_put without a preview is refused, naming the preview", unpreviewed.data);
  const preview = await call("monitor_draft_preview", { body: { name: monitorName, ...errorsMonitor } });
  check(preview.ok, "monitor_draft_preview of its errors", preview.data);
  const { saved_search: _s, ...drew } = preview.data;
  console.log(`   would have: ${JSON.stringify(drew).slice(0, 700)}`);

  const fpName = `${service} new error after a deploy`;
  const fpMonitor = { source: "fingerprints", service, saved_search_id: savedErrors.data.id, threshold: 1, webhook_urls: ["default"] };
  const fpPreview = await call("monitor_draft_preview", { body: { name: fpName, ...fpMonitor } });
  check(fpPreview.ok, "monitor_draft_preview of a new fingerprint after a deploy", fpPreview.data);
  console.log(`   says: ${JSON.stringify(fpPreview.data).slice(0, 300)}`);

  const shopSearch = await call("saved_search_create", { body: { name: service, query: `service:${service}`, range: "1h" } });
  check(shopSearch.ok, `saved search ${service}, for Home`, shopSearch.data);
  const errorsPanel = { kind: "timeseries", split: "level", chart: "bars", title: `${service} errors` };
  const p99Panel = { kind: "timeseries", agg: "p99(duration_ms)", title: `${service} p99` };
  for (const [what, panel] of [["errors", errorsPanel], ["p99", p99Panel]] as const) {
    const drawn = await call("panel_preview", { id: shopSearch.data.id, body: panel });
    check(drawn.ok, `panel_preview of ${what}`, drawn.data);
  }

  // ---- The person says yes to all of it: save each. ----
  const saved = await call("monitor_put", { name: monitorName, body: errorsMonitor });
  check(saved.ok && saved.data.undo?.tool === "monitor_delete", "monitor_put after its preview, with its undo", saved.data);
  const fpSaved = await call("monitor_put", { name: fpName, body: fpMonitor });
  check(fpSaved.ok, "monitor_put of the fingerprints monitor", fpSaved.data);
  const marking = await call("home_set", { body: { saved_id: shopSearch.data.id } });
  check(marking.ok && marking.data.undo?.tool === "home_set" && marking.data.undo.arguments.body.if_home === shopSearch.data.id, "home_set, with an undo that holds only while Home is still this", marking.data);
  const again = await call("home_set", { body: { saved_id: savedErrors.data.id } });
  check(!again.ok && JSON.stringify(again.data).includes("only where none is marked"), "an agent cannot move a Home that is marked", again.data);
  const added = [];
  for (const panel of [errorsPanel, p99Panel]) {
    const res = await call("panel_add", { id: "home", body: panel });
    check(res.ok && res.data.undo?.tool === "panel_remove", `panel_add ${panel.title} on Home`, res.data);
    added.push(res.data);
  }

  // A change to the monitor, and its undo: the webhook comes back as it was, never seen whole.
  const listed = await call("monitor_get", { name: monitorName });
  const shownHooks = listed.data.webhook_urls as string[];
  check(shownHooks[0] === "default" && /^https:\/\/hooks\.example\.test\/… kept:[0-9a-f]{12}$/.test(shownHooks[1]!), "monitor_get shows the webhook as its host and a handle", shownHooks);
  const changed = { ...errorsMonitor, threshold: 20, webhook_urls: ["default"] };
  check((await call("monitor_draft_preview", { body: { name: monitorName, ...changed } })).ok, "monitor_draft_preview of a change");
  const change = await call("monitor_put", { name: monitorName, body: changed });
  check(change.ok && change.data.undo?.tool === "monitor_put", "monitor_put of the change", change.data);
  const undoChange = await call(change.data.undo.tool, change.data.undo.arguments);
  check(undoChange.ok, `undo: ${change.data.undo.does}`, undoChange.data);
  const direct = (await (await fetch(`${base}/api/monitors/${encodeURIComponent(monitorName)}`, { headers: { authorization: `Bearer ${token}` } })).json()) as { threshold: number; webhook_urls: string[] };
  check(direct.threshold === 10 && JSON.stringify(direct.webhook_urls) === JSON.stringify(["default", secretHook]), "the undo put back the webhook as it was", direct);

  const watch = await call("monitors", {});
  const ours = (watch.data.monitors as Array<{ name: string; made_by?: { name: string; agent?: boolean } }>).filter((m) => m.name.startsWith(service));
  check(ours.length === 2 && ours.every((m) => m.made_by?.name === "agent: skill-e2e" && m.made_by.agent === true), "both monitors in Watch under the agent's badge", ours);

  // The CI step, as SKILL.md has it, into the fixture app's workflow file.
  const step = skill.match(/```yaml\n(- name: Mark deploy in Toposcope[\s\S]*?)```/)?.[1];
  check(step !== undefined, "SKILL.md has the CI step");
  const workflow = join(dir, "app/.github/workflows/deploy.yml");
  mkdirSync(join(dir, "app/.github/workflows"), { recursive: true });
  const indented = step!.replaceAll("<service>", service).split("\n").map((l) => (l ? `      ${l}` : l)).join("\n");
  writeFileSync(workflow, `name: Deploy\non:\n  push:\n    tags: ["v*"]\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: ./deploy.sh\n${indented}`);
  const parsed = Bun.YAML.parse(readFileSync(workflow, "utf8")) as any;
  const marker = parsed.jobs.deploy.steps.find((s: { name?: string }) => s.name === "Mark deploy in Toposcope");
  check(marker?.env?.TOPOSCOPE_SERVICE === service && !readFileSync(workflow, "utf8").includes("tsp1_") && !readFileSync(workflow, "utf8").includes(ingestToken), "the workflow parses, with the step and no token in it");
  // The step's shell, run as a runner would with no TOPOSCOPE_URL: it marks nothing and passes.
  const ran = Bun.spawnSync(["bash", "-c", marker.run], { env: { ...process.env, TOPOSCOPE_URL: "", TOPOSCOPE_INGEST_TOKEN: "", TOPOSCOPE_SERVICE: service } });
  check(ran.exitCode === 0 && ran.stdout.toString().includes("no deploy marked"), "the step skips itself while TOPOSCOPE_URL is empty");
  // And with it set, it marks a deploy.
  // And with it set, it marks a deploy, a tag with a quote in it staying text.
  const ref = 'v1.4.3"},"kind":"note';
  const sha = crypto.randomUUID().slice(0, 12);
  const ranSet = Bun.spawnSync(["bash", "-c", marker.run], {
    env: { ...process.env, TOPOSCOPE_URL: base, TOPOSCOPE_INGEST_TOKEN: ingestToken, TOPOSCOPE_SERVICE: service, GITHUB_REF_NAME: ref, GITHUB_SHA: sha },
  });
  check(ranSet.exitCode === 0 && !ranSet.stdout.toString().includes("::warning::"), "the step marks a deploy when TOPOSCOPE_URL is set", ranSet.stderr.toString());
  await Bun.sleep(1000);
  const ciMarks = await call("marks", { kind: "deploy", range: "1h" });
  const ciMark = (ciMarks.data.marks as Array<{ id: string; kind: string; title: string }>).find((m) => m.id === `deploy-${service}-${sha}`);
  check(ciMark?.kind === "deploy" && ciMark.title === ref, "its mark arrived as a deploy, the tag as text", ciMarks.data);
  // A mark the instance does not take warns and leaves the job green.
  const ranDown = Bun.spawnSync(["bash", "-c", marker.run], { env: { ...process.env, TOPOSCOPE_URL: "http://127.0.0.1:9", TOPOSCOPE_INGEST_TOKEN: ingestToken, TOPOSCOPE_SERVICE: service, GITHUB_REF_NAME: "v1", GITHUB_SHA: "d" } });
  check(ranDown.exitCode === 0 && ranDown.stdout.toString().includes("::warning::"), "a mark that fails warns and does not fail the job");

  // ---- Undo each, with the call each write answered with, newest first. ----
  for (const write of [...added].reverse()) {
    const undone = await call(write.undo.tool, write.undo.arguments);
    check(undone.ok, `undo: ${write.undo.does}`, undone.data);
  }
  for (const write of [marking.data, fpSaved.data, saved.data, shopSearch.data, savedErrors.data]) {
    const undone = await call(write.undo.tool, write.undo.arguments);
    check(undone.ok, `undo: ${write.undo.does}`, undone.data);
  }
  const after = await call("monitors", {});
  check(!(after.data.monitors as Array<{ name: string }>).some((m) => m.name.startsWith(service)), "the monitors are gone");
  check((await call("home", {})).data.saved_id === null, "Home is unmarked again");

  // ---- No token anywhere a person or `ps` would see it. ----
  check(!transcript.includes(token) && !transcript.includes(ingestToken), "no token in anything the script printed");
  if (transcript.includes(secretHook)) {
    const at = transcript.indexOf(secretHook);
    console.error(transcript.slice(Math.max(0, transcript.lastIndexOf("$ toposcope.sh", at)), at + 200).replaceAll(secretHook, "<HOOK>"));
  }
  check(!transcript.includes(secretHook), "no webhook URL in anything the script printed");
  const argv = readFileSync(argvLog, "utf8");
  check(argv.includes("/mcp") && !argv.includes(token), "no token in any argument curl was given");
  console.log("skill design e2e: passed");
  await finish(0);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  await finish(1);
}
