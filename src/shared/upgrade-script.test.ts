import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// #198: upgrade.sh, the operator script that upgrades a packaged install with a backup first and a
// way back. Docker, the instance, GitHub's releases and the release files all stand in on loopback:
// nothing real is started, pulled or backed up.
// A start that never comes up waits out its (shortened) wait before going back.
setDefaultTimeout(60_000);

const root = `${import.meta.dir}/../..`;
const script = `${root}/upgrade.sh`;
const scriptText = readFileSync(script, "utf8");
const token = "ingest-secret-upgrade-3c1e";
const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

const vector = "sources: {}\n";
const composeFor = (v: string) => `name: toposcope\nservices:\n  app:\n    image: ghcr.io/toposcope/toposcope:${v}\n`;
const example = `TOPOSCOPE_PASSWORD=\nTOPOSCOPE_INGEST_TOKEN=\n# TOPOSCOPE_UPDATE_CHECK=off\n# Local \`bun run dev\` only.\n# PORT=8080\n`;
function releaseFiles(v: string, envExample = example): Record<string, string> {
  const files: Record<string, string> = {
    "compose.yml": composeFor(v),
    "env.example": envExample,
    "vector.yaml": vector,
    LICENSE: "MIT\n",
    "toposcope.sh": "#!/usr/bin/env bash\n",
    "upgrade.sh": scriptText,
  };
  files.SHA256SUMS = Object.entries(files).map(([name, body]) => `${sha(body)}  ${name}`).join("\n") + "\n";
  return files;
}

let releases: Record<string, Record<string, string>> = {};
let marks: Array<{ authorization: string | null; body: Record<string, unknown> }> = [];
let state: string;
let server: ReturnType<typeof Bun.serve>;
let fakeBin: string;

let releaseList = () => [
  { tag_name: "v0.6.2", body: "A patch.\n\n**Before you upgrade:** Monitors remind every 4h by default.\n\nMore." },
  { tag_name: "v0.6.1", body: "The release check." },
];

beforeAll(() => {
  state = mkdtempSync(join(tmpdir(), "toposcope-upgrade-state-"));
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/health") {
        const v = existsSync(join(state, "version")) ? readFileSync(join(state, "version"), "utf8").trim() : "";
        return v
          ? Response.json({ ok: true, phase: "ready", clickhouse: true, sqlite: true, version: v })
          : Response.json({ ok: false, phase: "starting" }, { status: 503 });
      }
      if (url.pathname === "/v1/marks" && request.method === "POST") {
        marks.push({ authorization: request.headers.get("authorization"), body: (await request.json()) as Record<string, unknown> });
        return Response.json({ ingested: 1, id: "mk_test" });
      }
      if (url.pathname === "/api/releases/latest") return Response.json({ tag_name: "v0.6.2" });
      if (url.pathname === "/api/releases") return Response.json(releaseList());
      const m = /^\/release\/v([\d.]+)\/(.+)$/.exec(url.pathname);
      const body = m ? releases[m[1]!]?.[m[2]!] : undefined;
      return body === undefined ? new Response("not found", { status: 404 }) : new Response(body);
    },
  });
  // Docker stands in: it records each call; `up` makes a version healthy unless it is listed as
  // broken; a restore mends the version it restores; tar writes its file.
  fakeBin = mkdtempSync(join(tmpdir(), "toposcope-fake-docker-"));
  writeFileSync(
    join(fakeBin, "docker"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$FAKE_STATE/calls"
args=("$@")
file=""
for ((i = 0; i < \${#args[@]}; i++)); do
  [ "\${args[$i]}" = "-f" ] && [ -z "$file" ] && file="\${args[$((i + 1))]}"
done
broken() { grep -qx "$1" "$FAKE_STATE/broken" 2>/dev/null; }
case " $* " in
  *"--entrypoint /bin/sh"*)
    # A script run inside the app's volume: the stand-in volume is a directory here.
    script="\${args[$((\${#args[@]} - 1))]}"
    exec bash -c "\${script//\/data/$FAKE_VOLUME}" ;;
  *" config --format json"*) printf '{\\n  "name": "toposcope",\\n  "services": {}\\n}\\n' ;;
  *"volume inspect"*) [ -n "$FAKE_VOLUME" ] && printf '%s\\n' "$FAKE_VOLUME" || exit 1 ;;
  *" pull "*) exit 0 ;;
  *" stop"*) rm -f "$FAKE_STATE/version" ;;
  *" up -d"*)
    v="$(sed -n 's/.*toposcope:\\(.*\\)$/\\1/p' "$file" | head -n 1)"
    broken "$v" || printf '%s\\n' "$v" >"$FAKE_STATE/version" ;;
  *" logs "*) echo "fake app log line" ;;
  *"--entrypoint du"*) printf '%s\\t/data\\n' "\${FAKE_DU:-100}" ;;
  *"--entrypoint tar"*)
    for a in "$@"; do case "$a" in *:/backup) dir="\${a%:/backup}" ;; esac; done
    for a in "$@"; do case "$a" in /backup/*.tgz) echo backup >"$dir/\${a#/backup/}" ;; esac; done ;;
  *"--entrypoint sh"*)
    for a in "$@"; do case "$a" in ghcr.io/toposcope/toposcope:*) v="\${a#*:}" ;; esac; done
    grep -vx "$v" "$FAKE_STATE/broken" >"$FAKE_STATE/broken.next" 2>/dev/null; mv "$FAKE_STATE/broken.next" "$FAKE_STATE/broken" ;;
  *) exit 0 ;;
esac
`,
  );
  chmodSync(join(fakeBin, "docker"), 0o755);
  writeFileSync(join(fakeBin, "systemctl"), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >>"$FAKE_STATE/systemctl"\n`);
  chmodSync(join(fakeBin, "systemctl"), 0o755);
});

afterAll(() => {
  server.stop(true);
  rmSync(state, { recursive: true, force: true });
  rmSync(fakeBin, { recursive: true, force: true });
});

let install: string;

beforeEach(() => {
  releases = { "0.6.1": releaseFiles("0.6.1"), "0.6.2": releaseFiles("0.6.2") };
  marks = [];
  for (const f of ["calls", "broken", "version", "systemctl"]) rmSync(join(state, f), { force: true });
  writeFileSync(join(state, "version"), "0.6.1\n");
  writeFileSync(join(state, "broken"), "");
  install = mkdtempSync(join(tmpdir(), "toposcope-install-"));
  writeFileSync(join(install, "compose.yml"), composeFor("0.6.1"));
  writeFileSync(join(install, ".env"), `TOPOSCOPE_PASSWORD=operator-secret\nTOPOSCOPE_INGEST_TOKEN=${token}\n`);
  writeFileSync(join(install, "vector.yaml"), vector);
});

async function run(args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(["bash", script, ...args], {
    cwd: install,
    env: {
      ...process.env,
      TOPOSCOPE_DIR: install,
      TOPOSCOPE_URL: `http://127.0.0.1:${server.port}`,
      TOPOSCOPE_RELEASE_BASE: `http://127.0.0.1:${server.port}/release`,
      TOPOSCOPE_RELEASES_API: `http://127.0.0.1:${server.port}/api/releases`,
      TOPOSCOPE_UPGRADE_WAIT_SECONDS: "2",
      COMPOSE_PROJECT_NAME: "",
      FAKE_STATE: state,
      PATH: `${fakeBin}:${process.env.PATH}`,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out, err, all: out + err };
}

const calls = () => (existsSync(join(state, "calls")) ? readFileSync(join(state, "calls"), "utf8") : "");
const backups = () => (existsSync(join(install, "backups")) ? readdirSync(join(install, "backups")).sort() : []);

describe("upgrade.sh upgrades with a backup first (#198)", () => {
  test("0.6.1 → 0.6.2: checked files, a backup, the new compose.yml, the new version up, a deploy mark", async () => {
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.all).toContain("Toposcope 0.6.1 → 0.6.2");
    expect(r.all).toContain("Before you upgrade to 0.6.2: Monitors remind every 4h by default.");
    expect(readFileSync(join(install, "compose.yml"), "utf8")).toBe(composeFor("0.6.2"));
    expect(readFileSync(join(state, "version"), "utf8").trim()).toBe("0.6.2");
    const [b] = backups();
    expect(b).toMatch(/^\d{8}T\d{6}Z-0\.6\.1$/);
    for (const f of ["ch_data.tgz", "app_data.tgz", "compose.yml", "version"]) expect(existsSync(join(install, "backups", b!, f))).toBe(true);
    expect(readFileSync(join(install, "backups", b!, "compose.yml"), "utf8")).toBe(composeFor("0.6.1"));
    // The new release's own upgrade.sh finished it.
    expect(calls()).toContain("pull -q app");
    expect(r.all).toContain("Toposcope 0.6.2 is up.");
    expect(marks).toEqual([
      { authorization: `Bearer ${token}`, body: { kind: "deploy", service: "toposcope", title: "Toposcope 0.6.1 → 0.6.2", attrs: { backup: join(install, "backups", b!) } } },
    ]);
    // The pull comes before the stop; the stop before the backup.
    const log = calls();
    expect(log.indexOf("pull -q app")).toBeLessThan(log.indexOf(" stop"));
    expect(log.indexOf(" stop")).toBeLessThan(log.indexOf("--entrypoint tar"));
    expect(r.all).not.toContain(token);
    // 0.6.2's env.example names the same settings as 0.6.1's.
    expect(r.all).not.toContain("New settings");
  });

  test("Before you upgrade is the paragraph that starts with it, not a mention of it in another", async () => {
    // 0.6.1's own notes mention the lead mid-sentence, in the paragraph that brought the convention.
    const before = releaseList;
    releaseList = () => [
      {
        tag_name: "v0.6.2",
        body: "A version section may now carry one paragraph that starts **Before you upgrade:**, which the release body carries apart.\n\n**Before you upgrade:** Monitors remind every 4h by default.",
      },
    ];
    try {
      const r = await run(["0.6.2"]);
      expect(r.code).toBe(0);
      expect(r.all).toContain("Before you upgrade to 0.6.2: Monitors remind every 4h by default.");
      expect(r.all).not.toContain("which the release body carries apart");
    } finally {
      releaseList = before;
    }
  });

  test("a 0.6.2 that never comes up ends back on 0.6.1, said and marked", async () => {
    writeFileSync(join(state, "broken"), "0.6.2\n");
    const r = await run(["0.6.2"]);
    expect(r.code).toBe(1);
    expect(r.all).toContain("Toposcope 0.6.2 did not come up.");
    expect(r.all).toContain("Back on 0.6.1.");
    expect(readFileSync(join(install, "compose.yml"), "utf8")).toBe(composeFor("0.6.1"));
    expect(readFileSync(join(state, "version"), "utf8").trim()).toBe("0.6.1");
    expect(marks.map((m) => m.body.title)).toEqual(["Toposcope 0.6.2 did not start; back on 0.6.1"]);
    expect(calls()).not.toContain("--entrypoint sh");
  });

  test("when 0.6.1 cannot open its data either, both volumes come back from the backup", async () => {
    writeFileSync(join(state, "broken"), "0.6.2\n0.6.1\n");
    const r = await run(["0.6.2"]);
    expect(r.code).toBe(1);
    expect(r.all).toContain("Restoring both volumes from");
    expect(r.all).toContain("Back on 0.6.1, restored from");
    expect(calls()).toContain("--entrypoint sh");
    expect(readFileSync(join(state, "version"), "utf8").trim()).toBe("0.6.1");
    expect(marks.map((m) => m.body.title)).toEqual(["Toposcope 0.6.2 did not start; back on 0.6.1, restored from the backup"]);
  });

  test("a file changed after it was summed is refused before anything stops", async () => {
    releases["0.6.2"]!["compose.yml"] = composeFor("0.6.2") + "  evil: {}\n";
    const r = await run(["0.6.2"]);
    expect(r.code).toBe(1);
    expect(r.all).toContain("compose.yml from the 0.6.2 release does not match its SHA256SUMS. Nothing was changed.");
    expect(calls()).not.toContain(" stop");
    expect(readFileSync(join(install, "compose.yml"), "utf8")).toBe(composeFor("0.6.1"));
  });

  test("--no-backup skips the backup, and says what the way back is then", async () => {
    const r = await run(["0.6.2", "--no-backup"]);
    expect(r.code).toBe(0);
    expect(r.all).toContain("No backup (--no-backup)");
    expect(backups()).toEqual([]);
  });

  test("too little disk for the backup is refused with the numbers, before the files change", async () => {
    const r = await run(["0.6.2"], { FAKE_DU: "999999999999" });
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/The backup needs about \d+ MB and .* has \d+ MB free/);
    expect(readFileSync(join(install, "compose.yml"), "utf8")).toBe(composeFor("0.6.1"));
  });

  test("a version that is not newer is refused, and pointed at rollback", async () => {
    const r = await run(["0.6.1"]);
    expect(r.code).toBe(1);
    expect(r.all).toContain("0.6.1 is not newer than the running 0.6.1. To go back, run: ./upgrade.sh rollback");
  });

  test("an edited vector.yaml is kept, the new one beside it", async () => {
    releases["0.6.2"] = { ...releaseFiles("0.6.2") };
    writeFileSync(join(install, "vector.yaml"), "sources: { mine: {} }\n");
    const files = releaseFiles("0.6.2");
    files["vector.yaml"] = "sources: { new: {} }\n";
    files.SHA256SUMS = Object.entries(files).filter(([n]) => n !== "SHA256SUMS").map(([n, b]) => `${sha(b)}  ${n}`).join("\n") + "\n";
    releases["0.6.2"] = files;
    const r = await run(["0.6.2"]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(install, "vector.yaml"), "utf8")).toBe("sources: { mine: {} }\n");
    expect(readFileSync(join(install, "vector.yaml.new"), "utf8")).toBe("sources: { new: {} }\n");
  });
});

describe("backup and rollback", () => {
  test("backup keeps the last 3", async () => {
    for (let i = 0; i < 4; i++) expect((await run(["backup"])).code).toBe(0);
    expect(backups()).toHaveLength(3);
  });

  test("rollback says what it would lose and goes back only with --yes", async () => {
    expect((await run(["0.6.2"])).code).toBe(0);
    const told = await run(["rollback"]);
    expect(told.code).toBe(1);
    expect(told.all).toContain("everything stored since then is lost");
    expect(told.all).toContain("Run ./upgrade.sh rollback --yes to go back.");
    expect(readFileSync(join(state, "version"), "utf8").trim()).toBe("0.6.2");
    const done = await run(["rollback", "--yes"]);
    expect(done.code).toBe(0);
    expect(readFileSync(join(install, "compose.yml"), "utf8")).toBe(composeFor("0.6.1"));
    expect(readFileSync(join(state, "version"), "utf8").trim()).toBe("0.6.1");
    expect(marks.at(-1)!.body.title).toBe("Toposcope 0.6.2 → 0.6.1 (rolled back)");
  });
});

describe("the script's reach", () => {
  test("it never opens a path in the app's volume itself: reads and writes there run in a container (#220)", () => {
    const section = scriptText.slice(scriptText.indexOf("# --- Upgrade from here"));
    // The host path appears once, for the path unit to watch.
    expect([...section.matchAll(/\$dir\//g)]).toHaveLength(1);
    expect(section).toContain("PathExists=$dir/request.json");
    expect(section).not.toMatch(/>\s*"?\$(dir|tmp)/);
    expect(section).toContain("--network none");
  });

  test("it talks to this machine and to GitHub, nothing else", () => {
    const hosts = [...scriptText.matchAll(/https?:\/\/([a-z0-9.-]+)/g)].map((u) => u[1]!);
    expect([...new Set(hosts)].sort()).toEqual(["127.0.0.1", "api.github.com", "github.com"]);
  });

  test("it removes only old backups and the volumes it restores", () => {
    expect(scriptText).not.toMatch(/\bcompose (down|rm|kill)\b/);
    expect(scriptText).not.toMatch(/\bdocker volume rm\b|\bprune\b/);
    expect([...scriptText.matchAll(/\brm -rf\b/g)]).toHaveLength(2);
  });
});

describe("upgrade from here (#220)", () => {
  let volume: string;
  let units: string;
  let systemdRun: string;
  beforeEach(() => {
    volume = mkdtempSync(join(tmpdir(), "toposcope-app-volume-"));
    units = mkdtempSync(join(tmpdir(), "toposcope-units-"));
    systemdRun = mkdtempSync(join(tmpdir(), "toposcope-systemd-run-"));
  });
  const env = () => ({ FAKE_VOLUME: volume, TOPOSCOPE_SYSTEMD_DIR: units, TOPOSCOPE_SYSTEMD_RUN: systemdRun });
  const up = (f: string) => join(volume, "upgrade", f);
  const status = () => JSON.parse(readFileSync(up("status.json"), "utf8")) as Record<string, string | null>;
  const systemctl = () => (existsSync(join(state, "systemctl")) ? readFileSync(join(state, "systemctl"), "utf8") : "");
  const ask = (version: string) => {
    mkdirSync(join(volume, "upgrade"), { recursive: true });
    writeFileSync(up("request.json"), JSON.stringify({ version, requested_at: "2026-10-24T14:02:00Z" }));
  };

  test("enable-ui installs a path unit on the app's request file and a service that runs ui-run here", async () => {
    mkdirSync(join(volume, "upgrade"), { recursive: true });
    writeFileSync(up("request.json"), '{"version":"0.6.2"}');
    const r = await run(["enable-ui"], env());
    expect(r.code).toBe(0);
    const path = readFileSync(join(units, "toposcope-upgrade-toposcope.path"), "utf8");
    const service = readFileSync(join(units, "toposcope-upgrade-toposcope.service"), "utf8");
    expect(path).toContain(`PathExists=${up("request.json")}`);
    expect(service).toContain(`ExecStart=${install}/upgrade.sh ui-run`);
    expect(service).toContain(`WorkingDirectory=${install}`);
    expect(service).toContain("COMPOSE_PROJECT_NAME=toposcope");
    expect(service).toContain("TimeoutStartSec=infinity");
    expect(systemctl()).toBe("daemon-reload\nenable --now toposcope-upgrade-toposcope.path\n");
    expect(existsSync(up("enabled"))).toBe(true);
    // A request left from before does not start an upgrade the moment the unit is on.
    expect(existsSync(up("request.json"))).toBe(false);
    expect(r.all).toContain("./upgrade.sh disable-ui");
  });

  test("enable-ui on a host without systemd says the command still works, and installs nothing", async () => {
    const r = await run(["enable-ui"], { ...env(), TOPOSCOPE_SYSTEMD_RUN: join(systemdRun, "absent") });
    expect(r.code).toBe(1);
    expect(r.all).toContain("needs systemd");
    expect(readdirSync(units)).toEqual([]);
  });

  test("disable-ui removes the units and the app's flag", async () => {
    expect((await run(["enable-ui"], env())).code).toBe(0);
    const r = await run(["disable-ui"], env());
    expect(r.code).toBe(0);
    expect(readdirSync(units)).toEqual([]);
    expect(existsSync(up("enabled"))).toBe(false);
    expect(systemctl()).toContain("disable --now toposcope-upgrade-toposcope.path");
  });

  test("ui-run takes the request first, runs the ordinary upgrade, and says it is done with the backup", async () => {
    ask("0.6.2");
    const r = await run(["ui-run"], env());
    expect(r.code).toBe(0);
    expect(existsSync(up("request.json"))).toBe(false);
    expect(readFileSync(join(state, "version"), "utf8").trim()).toBe("0.6.2");
    const s = status();
    expect(s).toMatchObject({ state: "done", to: "0.6.2", from: "0.6.1", message: null });
    expect(s.backup).toBe(join(install, "backups", backups()[0]!));
    expect(s.started_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(readFileSync(up("last.log"), "utf8")).toContain("Toposcope 0.6.2 is up.");
    expect(readFileSync(up("last.log"), "utf8")).not.toContain(token);
  });

  test("a version that never comes up: failed, back on the old one, in upgrade.sh's own words", async () => {
    writeFileSync(join(state, "broken"), "0.6.2\n");
    ask("0.6.2");
    const r = await run(["ui-run"], env());
    expect(r.code).toBe(1);
    expect(status()).toMatchObject({ state: "failed", to: "0.6.2", from: "0.6.1", message: "Toposcope 0.6.2 did not come up." });
    expect(readFileSync(join(state, "version"), "utf8").trim()).toBe("0.6.1");
  });

  test("a request that is not a bare X.Y.Z runs nothing", async () => {
    ask('0.6.2; touch /tmp/pwned');
    const r = await run(["ui-run"], env());
    expect(r.code).toBe(1);
    expect(status()).toMatchObject({ state: "failed", message: "The request did not name a release (X.Y.Z)." });
    expect(calls()).not.toContain("pull");
    expect(existsSync(up("request.json"))).toBe(false);
  });

  test("a release that is not there: failed, said, and nothing stopped", async () => {
    ask("0.6.9");
    const r = await run(["ui-run"], env());
    expect(r.code).toBe(1);
    expect(status()).toMatchObject({ state: "failed", to: "0.6.9", message: "The 0.6.9 release has no SHA256SUMS, so its files cannot be checked. Nothing was changed." });
    expect(calls()).not.toContain(" stop");
  });

  test("no request, nothing to do", async () => {
    const r = await run(["ui-run"], env());
    expect(r.code).toBe(0);
    expect(calls()).not.toContain("pull");
    expect(calls()).not.toContain(" stop");
  });
});

describe("upgrade.sh names only the settings a release adds to env.example (#256)", () => {
  test("a release whose env.example names the same settings names none, though .env lacks its commented examples", async () => {
    // agental's 0.7.2 → 0.7.3: an .env from an older install holds only the values it sets.
    const r = await run(["0.6.2"]);
    expect(r.code).toBe(0);
    expect(r.all).not.toContain("New settings");
    expect(r.all).not.toContain("PORT");
  });

  test("a setting the release adds is named, commented or not, unless .env already has it", async () => {
    releases["0.6.2"] = releaseFiles(
      "0.6.2",
      `${example}# TOPOSCOPE_WATCHDOG_URL=https://hc-ping.com/your-check-uuid\n# TOPOSCOPE_PUBLIC_URL=https://toposcope.example.com\nTOPOSCOPE_NEW_KEY=\n`,
    );
    writeFileSync(join(install, ".env"), `TOPOSCOPE_PASSWORD=operator-secret\nTOPOSCOPE_INGEST_TOKEN=${token}\nTOPOSCOPE_PUBLIC_URL=https://logs.example\n`);
    const r = await run(["0.6.2"]);
    expect(r.code).toBe(0);
    expect(r.all).toContain("New settings in env.example that .env does not have: TOPOSCOPE_NEW_KEY TOPOSCOPE_WATCHDOG_URL (each is described there).");
  });

  test("the env.example beside .env is the running release's, and is what the new one is compared with", async () => {
    // An env.example from before the release check: 0.6.2 brings TOPOSCOPE_UPDATE_CHECK to this install.
    writeFileSync(join(install, "env.example"), `TOPOSCOPE_PASSWORD=\nTOPOSCOPE_INGEST_TOKEN=\n`);
    const r = await run(["0.6.2"]);
    expect(r.code).toBe(0);
    expect(r.all).toContain("New settings in env.example that .env does not have: PORT TOPOSCOPE_UPDATE_CHECK (each is described there).");
  });
});
