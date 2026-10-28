import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guideSection } from "../../scripts/ingest-guide-examples";
import { mapOtlpJson } from "../ingest/otlp";
import { flattenAttrs } from "./attrs";
import { liftException } from "./exception";
import { withFingerprint } from "./fingerprint";
import { liftIdentities } from "./identity";
import type { LogEvent } from "./log-event";

const root = `${import.meta.dir}/../..`;
const skillDir = `${root}/skills/toposcope`;
const script = `${skillDir}/toposcope.sh`;
const skill = await Bun.file(`${skillDir}/SKILL.md`).text();
const scriptText = await Bun.file(script).text();
const guide = await Bun.file(`${root}/docs/ingest.md`).text();
const pkg = (await Bun.file(`${root}/package.json`).json()) as { version: string };

describe("the skill's shape", () => {
  test("frontmatter names the skill after its directory and says when to use it", () => {
    const frontmatter = skill.match(/^---\nname: (.+)\ndescription: (.+)\n---\n/);
    expect(frontmatter?.[1]).toBe("toposcope");
    expect(frontmatter?.[2]?.length).toBeGreaterThan(80);
    expect(frontmatter?.[2]?.length).toBeLessThanOrEqual(1024);
    expect(frontmatter?.[2]).toContain("Use when");
  });

  test("the one file it names is there and runs", () => {
    expect(skill).toContain("toposcope.sh");
    expect(statSync(script).mode & 0o111).not.toBe(0);
    expect(scriptText.startsWith("#!/usr/bin/env bash\n")).toBe(true);
  });

  test("every command it names is one the script has", () => {
    const named = [...new Set([...skill.matchAll(/^\| `([a-z-]+)(?: [^`]*)?` \|/gm)].map((row) => row[1]!))];
    expect(named.sort()).toEqual(["app-env", "check", "cost", "marker", "status", "stop", "up"]);
    for (const command of named) {
      expect(scriptText).toMatch(new RegExp(`^  ${command}\\) `, "m"));
    }
  });

  test("its copy of What an app sends is the ingest guide's, word for word", () => {
    const carried = skill.match(
      /<!-- ingest-guide: What an app sends -->\n([\s\S]*?)<!-- \/ingest-guide -->/,
    );
    expect(carried?.[1]).toBe(guideSection(guide, "What an app sends"));
  });

  test("it ships with the release in package.json", () => {
    expect(scriptText.match(/^VERSION="(.+)"$/m)?.[1]).toBe(pkg.version);
  });

  test("the script talks to this machine and to the release it downloads, nothing else", () => {
    const hosts = [...scriptText.matchAll(/https?:\/\/([a-z0-9.-]+)/g)].map((url) => url[1]!);
    expect([...new Set(hosts)].sort()).toEqual(["127.0.0.1", "github.com"]);
  });

  test("the script cannot remove data", () => {
    expect(scriptText).not.toMatch(/\bcompose (down|rm|kill)\b/);
    expect(scriptText).not.toMatch(/\b(rm|rmi|prune|truncate)\b/);
    // The only thing it asks Docker about volumes and images is whether they exist.
    const asked = [...scriptText.matchAll(/\bdocker (volume|image|manifest|system) (\w+)/g)].map(
      (call) => `${call[1]} ${call[2]}`,
    );
    expect([...new Set(asked)].sort()).toEqual(["manifest inspect", "volume inspect"]);
  });
});

// The read token `check` keeps beside .env (#305: there is no shared password to read with).
const readToken = "tsp1_skill-read-0f3a9c";
const token = "ingest-secret-7b21d4";
const word = "tscheck0123456789ab";

let home: string;
let server: ReturnType<typeof Bun.serve>;
let reply: unknown = {};
let seen: Array<{ authorization: string | null; q: string | null; range: string | null }> = [];
let checks: Array<{ authorization: string | null; agent: string | null; body: Record<string, unknown> }> = [];
/** A stand-in release on loopback, for `up` (#195): file name → body; absent names answer 404. */
let releaseFiles: Record<string, string> = {};

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "toposcope-skill-"));
  writeFileSync(
    join(home, ".env"),
    `CLICKHOUSE_USER=default\nCLICKHOUSE_PASSWORD=clickhouse-secret-55e0\nTOPOSCOPE_INGEST_TOKEN=${token}\n`,
  );
  writeFileSync(join(home, "skill.token"), `${readToken}\n`);
  // Stands in for the instance's search route, on loopback.
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/release/")) {
        const body = releaseFiles[url.pathname.slice("/release/".length)];
        return body === undefined ? new Response("not found", { status: 404 }) : new Response(body);
      }
      // Stands in for `POST /v1/checks` too, for `check <monitor> -- <command>`.
      if (url.pathname === "/v1/checks" && request.method === "POST") {
        checks.push({
          authorization: request.headers.get("authorization"),
          agent: request.headers.get("user-agent"),
          body: (await request.json()) as Record<string, unknown>,
        });
        return Response.json({ ingested: 1, created: [] });
      }
      if (url.pathname !== "/api/search") {
        return new Response("not found", { status: 404 });
      }
      seen.push({
        authorization: request.headers.get("authorization"),
        q: url.searchParams.get("q"),
        range: url.searchParams.get("range"),
      });
      return Response.json(reply);
    },
  });
});

afterAll(() => {
  server.stop(true);
  rmSync(home, { recursive: true, force: true });
});

async function run(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  return runWith({}, ...args);
}

async function runWith(env: Record<string, string>, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const { TOPOSCOPE_URL: _url, TOPOSCOPE_INGEST_TOKEN: _token, ...inherited } = process.env;
  const child = Bun.spawn(["bash", script, ...args], {
    env: {
      ...inherited,
      TOPOSCOPE_DIR: home,
      TOPOSCOPE_PORT: String(server.port),
      TOPOSCOPE_CHECK_WAIT: "0",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, out, err };
}

/** What the search route returns for these stored rows. */
function found(events: LogEvent[]): unknown {
  return {
    events: events.map((event) => ({
      ...event,
      attrs: flattenAttrs(
        withFingerprint(event.level, event.message, liftIdentities(liftException(event.attrs))),
      ),
    })),
    histogram: [],
    total: events.length,
    nextCursor: null,
    from: "2026-10-07T12:00:00.000Z",
    to: "2026-10-07T12:15:00.000Z",
  };
}

/** The row a real exporter's request maps to, with the test word in its message. */
async function exported(): Promise<LogEvent> {
  const request = (await Bun.file(`${root}/fixtures/ingest/otlp/node.logs.json`).json()) as unknown;
  const [event] = mapOtlpJson(request);
  if (!event) {
    throw new Error("the fixture mapped to no row");
  }
  return { ...event, message: word };
}

describe("check", () => {
  test("says frames for the row a real exporter's request stores", async () => {
    reply = found([await exported()]);
    seen = [];
    const { code, out } = await run("check", word);
    expect(code).toBe(0);
    expect(out.split("\n")[0]).toBe("frames");
    expect(out).toContain(`q: ${word} OR exception.message:${word}\n`);
    expect(out).toMatch(/q for this error from now on: e1:[0-9a-f]{16}\n/);
    expect(out).toContain("window: the last 15 minutes (2026-10-07T12:00:00.000Z to 2026-10-07T12:15:00.000Z)");
    expect(seen).toEqual([
      {
        authorization: `Bearer ${readToken}`,
        q: `${word} OR exception.message:${word}`,
        range: "15m",
      },
    ]);
  });

  test("says message when the exception is not on the row", async () => {
    const { attrs: _attrs, ...row } = await exported();
    reply = found([row]);
    const { code, out } = await run("check", word);
    expect(code).toBe(0);
    expect(out.split("\n")[0]).toBe("message");
    expect(out).toMatch(/e1:[0-9a-f]{16}/);
  });

  test("says nothing arrived when no row has the word", async () => {
    reply = found([]);
    const { code, out } = await run("check", word);
    expect(code).toBe(0);
    expect(out.split("\n")[0]).toBe("nothing arrived");
    expect(out).toContain(`q: ${word} OR exception.message:${word}\n`);
  });

  test("never prints its read token", async () => {
    reply = found([await exported()]);
    const { out, err } = await run("check", word);
    expect(out + err).not.toContain(readToken);
  });

  test("takes only a word that marker printed, and sends nothing else", async () => {
    seen = [];
    const { code, err } = await run("check", "level:error");
    expect(code).not.toBe(0);
    expect(err).toContain("marker");
    expect(seen).toEqual([]);
  });
});

describe("marker", () => {
  test("prints one word that is a single search token", async () => {
    const { code, out } = await run("marker");
    expect(code).toBe(0);
    expect(out).toMatch(/^tscheck[0-9a-f]{12}\n$/);
  });
});

describe("app-env", () => {
  test("writes the settings to a private file and prints no secret", async () => {
    const file = join(home, "app.env");
    const { code, out, err } = await run("app-env", file, "--service", "billing", "--version", "1.4.2");
    expect(code).toBe(0);
    expect(out + err).not.toContain(token);
    expect(statSync(file).mode & 0o077).toBe(0);
    const written = readFileSync(file, "utf8");
    for (const line of [
      "OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:8080",
      "OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf",
      `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20${token}`,
      "OTEL_LOGS_EXPORTER=otlp",
      "OTEL_METRICS_EXPORTER=otlp",
      "OTEL_SERVICE_NAME=billing",
      "OTEL_RESOURCE_ATTRIBUTES=service.version=1.4.2",
      `TOPOSCOPE_INGEST_TOKEN=${token}`,
    ]) {
      expect(written.split("\n")).toContain(line);
    }
  });

  test("matches the exporter settings the ingest guide shows", async () => {
    const file = join(home, "guide.env");
    await run("app-env", file, "--service", "billing", "--version", "1.4.2");
    const written = readFileSync(file, "utf8").split("\n");
    const shown = guideSection(guide, "What an app sends").match(/```bash\n(OTEL_[\s\S]*?)```/)?.[1] ?? "";
    for (const line of shown.trim().split("\n")) {
      expect(written).toContain(line.replace("${TOPOSCOPE_INGEST_TOKEN}", token));
    }
  });

  test("will not overwrite a file it did not write", async () => {
    const file = join(home, "theirs.env");
    writeFileSync(file, "DATABASE_URL=postgres://localhost/app\n");
    const { code } = await run("app-env", file);
    expect(code).not.toBe(0);
    expect(readFileSync(file, "utf8")).toBe("DATABASE_URL=postgres://localhost/app\n");
  });
});

describe("check <monitor> -- <command> (#177)", () => {
  const plugin = "printf '%s\\n' 'DISK WARNING - free space: /var 6.4 GiB (13% inode=91%);| /var=87.2%;80;90;0;100' 'more detail'; exit 1";

  test("a Nagios plugin: its exit code is the status, its first line the message, its first perfdata the value", async () => {
    checks = [];
    const { code, out } = await run("check", "disk-var", "--", "sh", "-c", plugin);
    expect(code).toBe(1);
    expect(out).toContain("DISK WARNING - free space");
    expect(checks).toHaveLength(1);
    expect(checks[0]!.authorization).toBe(`Bearer ${token}`);
    expect(checks[0]!.agent).toBe(`toposcope.sh/${pkg.version}`);
    expect(checks[0]!.body).toMatchObject({
      monitor: "disk-var",
      status: 1,
      exit_code: 1,
      message: "DISK WARNING - free space: /var 6.4 GiB (13% inode=91%);",
      value: 87.2,
      unit: "%",
    });
    expect(typeof checks[0]!.body.duration_ms).toBe("number");
    expect(typeof checks[0]!.body.host).toBe("string");
  });

  test("any command: past 3 its exit code is a fail, and the tail of its output is the message", async () => {
    checks = [];
    const { code } = await run("check", "nightly backup", "--", "sh", "-c", 'printf \'%s\\n\' \'a "quoted" back\\slash\' line2; exit 7');
    expect(code).toBe(7);
    expect(checks[0]!.body).toMatchObject({
      monitor: "nightly backup",
      status: "fail",
      exit_code: 7,
      message: 'a "quoted" back\\slash\nline2',
    });
    expect(checks[0]!.body.value).toBeUndefined();
  });

  test("an ok command is status 0", async () => {
    checks = [];
    const { code } = await run("check", "rotate", "--", "true");
    expect(code).toBe(0);
    expect(checks[0]!.body).toMatchObject({ monitor: "rotate", status: 0, exit_code: 0, message: "" });
  });

  test("sends to TOPOSCOPE_URL with TOPOSCOPE_INGEST_TOKEN when they are set, and prints no token", async () => {
    checks = [];
    const { out, err } = await runWith(
      { TOPOSCOPE_URL: `http://127.0.0.1:${server.port}`, TOPOSCOPE_INGEST_TOKEN: "another-token-91ac", TOPOSCOPE_DIR: "/nonexistent" },
      "check",
      "rotate",
      "--",
      "true",
    );
    expect(checks[0]!.authorization).toBe("Bearer another-token-91ac");
    expect(out + err).not.toContain("another-token-91ac");
  });

  test("a result it cannot send is said, and the command's exit code still passes through", async () => {
    const { code, err } = await runWith({ TOPOSCOPE_URL: "http://127.0.0.1:9" }, "check", "rotate", "--", "sh", "-c", "exit 2");
    expect(code).toBe(2);
    expect(err).toContain("The result of rotate was not sent to http://127.0.0.1:9.");
  });

  test("wants a command after --", async () => {
    const { code, err } = await run("check", "rotate", "--");
    expect(code).not.toBe(0);
    expect(err).toContain("check <monitor> -- <command>");
  });
});

describe("up checks the release's files against its SHA256SUMS (#195)", () => {
  const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
  const files: Record<string, string> = {
    "compose.yml": "services: {}\n",
    "env.example": "CLICKHOUSE_PASSWORD=\nTOPOSCOPE_INGEST_TOKEN=\n",
    "vector.yaml": "sources: {}\n",
    LICENSE: "MIT\n",
    "toposcope.sh": "#!/usr/bin/env bash\n",
  };
  const sums = (from: Record<string, string>) =>
    Object.entries(from).map(([name, body]) => `${sha(body)}  ${name}`).join("\n") + "\n";

  // Docker stands in too, so nothing starts: it says no volume and no manifest, and refuses `up`.
  function fakeDocker(): string {
    const bin = mkdtempSync(join(tmpdir(), "toposcope-fake-docker-"));
    writeFileSync(
      join(bin, "docker"),
      '#!/usr/bin/env bash\ncase "$1 $2" in\n  "compose version") exit 0 ;;\n  "volume inspect" | "manifest inspect") exit 1 ;;\n  *) echo "fake docker refused: $*" >&2; exit 1 ;;\nesac\n',
    );
    chmodSync(join(bin, "docker"), 0o755);
    return bin;
  }

  async function up(): Promise<{ code: number; err: string; dir: string }> {
    const dir = join(mkdtempSync(join(tmpdir(), "toposcope-up-")), "instance");
    const { code, err } = await runWith(
      { TOPOSCOPE_DIR: dir, TOPOSCOPE_RELEASE_URL: `http://127.0.0.1:${server.port}/release`, PATH: `${fakeDocker()}:${process.env.PATH}` },
      "up",
    );
    return { code, err, dir };
  }

  test("files that match go in place, and only then does it try to start", async () => {
    releaseFiles = { ...files, SHA256SUMS: sums(files) };
    const { code, err, dir } = await up();
    expect(code).not.toBe(0);
    expect(err).toContain("docker compose could not start the instance");
    for (const name of Object.keys(files)) {
      expect(readFileSync(join(dir, name), "utf8")).toBe(files[name]!);
      expect(existsSync(join(dir, `${name}.part`))).toBe(false);
    }
  });

  test("a file changed after it was summed starts nothing, and says which", async () => {
    releaseFiles = { ...files, SHA256SUMS: sums(files), "compose.yml": "services: { evil: {} }\n" };
    const { code, err, dir } = await up();
    expect(code).toBe(1);
    expect(err).toContain("compose.yml from the");
    expect(err).toContain("does not match its SHA256SUMS");
    expect(existsSync(join(dir, "compose.yml"))).toBe(false);
    expect(existsSync(join(dir, ".env"))).toBe(false);
  });

  test("a release with no SHA256SUMS starts nothing", async () => {
    releaseFiles = { ...files };
    const { code, err, dir } = await up();
    expect(code).toBe(1);
    expect(err).toContain("Could not download SHA256SUMS");
    expect(existsSync(join(dir, "compose.yml"))).toBe(false);
  });

  test("a file the sums do not list starts nothing", async () => {
    const { LICENSE: _license, ...rest } = files;
    releaseFiles = { ...files, SHA256SUMS: sums(rest) };
    const { code, err } = await up();
    expect(code).toBe(1);
    expect(err).toContain("does not list LICENSE");
  });
});

describe("agent <name> (#357)", () => {
  // Stands in for `docker compose exec -T app bun run src/cli.ts …`: the same command, run here on
  // a database of its own.
  let instance: string;
  let bin: string;
  let database: string;

  beforeAll(() => {
    instance = mkdtempSync(join(tmpdir(), "toposcope-agent-"));
    writeFileSync(join(instance, ".env"), `TOPOSCOPE_INGEST_TOKEN=${token}\n`);
    writeFileSync(join(instance, "compose.yml"), "services: {}\n");
    bin = mkdtempSync(join(tmpdir(), "toposcope-agent-bin-"));
    database = join(instance, "control.sqlite");
    writeFileSync(
      join(bin, "docker"),
      [
        "#!/usr/bin/env bash",
        'all="$*"',
        '[ "${all#compose exec -T app bun run src/cli.ts }" != "$all" ] || exit 64',
        "shift 7",
        `SQLITE_PATH=${JSON.stringify(database)} ${JSON.stringify(process.execPath)} run ${JSON.stringify(`${root}/src/cli.ts`)} "$@" || exit $?`,
        // A container that answers and then fails, after the token was made.
        '[ "$1" != agent ] || [ -z "${AGENT_TEST_FAIL:-}" ] || exit 1',
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "docker"), 0o755);
  });

  afterAll(() => {
    rmSync(instance, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  });

  const agentRun = (...args: string[]) => runWith({ TOPOSCOPE_DIR: instance, PATH: `${bin}:${process.env.PATH}` }, ...args);

  test("twice leaves one Operator agent and two tokens, the newest in a file only the user can read, and prints none", async () => {
    const first = await agentRun("agent", "claude");
    expect(first.err).toBe("");
    expect(first.code).toBe(0);
    const file = join(instance, "agent-claude.token");
    const firstToken = readFileSync(file, "utf8").trim();
    const second = await agentRun("agent", "claude");
    expect(second.code).toBe(0);
    const secondToken = readFileSync(file, "utf8").trim();

    expect(firstToken).toMatch(/^tsp1_/);
    expect(secondToken).toMatch(/^tsp1_/);
    expect(secondToken).not.toBe(firstToken);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    for (const out of [first.out + first.err, second.out + second.err]) {
      expect(out).not.toContain("tsp1_");
      expect(out).toContain(file);
    }
    expect(first.out).toContain("Made agent: claude, an Operator.");
    expect(second.out).toContain("agent: claude is an Operator already");
    expect(second.out).toContain(`--header "Authorization: Bearer $(cat ${file})"`);

    const db = new Database(database, { readonly: true });
    const accounts = db.query("SELECT id, kind, name, role, agent FROM people").all() as Array<{ id: string; kind: string; name: string; role: string; agent: number }>;
    expect(accounts.map(({ kind, name, role, agent }) => ({ kind, name, role, agent }))).toEqual([{ kind: "service", name: "agent: claude", role: "operator", agent: 1 }]);
    const tokens = db.query("SELECT token_hash FROM person_tokens WHERE person_id = ? AND revoked_at IS NULL").all(accounts[0]!.id) as Array<{ token_hash: string }>;
    expect(tokens.length).toBe(2);
    const hashOf = (t: string) => createHash("sha256").update(t).digest("hex");
    expect(tokens.map((t) => t.token_hash).sort()).toEqual([hashOf(firstToken), hashOf(secondToken)].sort());
    db.close();
  });

  const liveTokens = (name: string) => {
    const db = new Database(database, { readonly: true });
    const n = (db.query("SELECT count(*) AS n FROM person_tokens t JOIN people p ON p.id = t.person_id WHERE p.name = ? AND t.revoked_at IS NULL").get(`agent: ${name}`) as { n: number }).n;
    const all = (db.query("SELECT count(*) AS n FROM person_tokens t JOIN people p ON p.id = t.person_id WHERE p.name = ?").get(`agent: ${name}`) as { n: number }).n;
    db.close();
    return { live: n, all };
  };

  test("takes only a name an agent may have, and asks the instance nothing otherwise", async () => {
    for (const name of ["claude; id", "claude\nx", "x".repeat(58), ""]) {
      const { code, err } = await agentRun("agent", name);
      expect(code).not.toBe(0);
      expect(err).toContain("Usage: agent <name>");
    }
    expect(existsSync(join(instance, "agent-claude\nx.token"))).toBe(false);
  });

  test("writes no token through a link, and makes none", async () => {
    const target = join(instance, "elsewhere");
    writeFileSync(target, "kept as it was\n");
    symlinkSync(target, join(instance, "agent-linked.token"));
    const { code, err, out } = await agentRun("agent", "linked");
    expect(code).not.toBe(0);
    expect(err).toContain("is not a regular file");
    expect(out + err).not.toContain("tsp1_");
    expect(readFileSync(target, "utf8")).toBe("kept as it was\n");
    expect(liveTokens("linked").all).toBe(0);
  });

  test("a token the script cannot keep is revoked, and not shown", async () => {
    const { code, out, err } = await runWith({ TOPOSCOPE_DIR: instance, PATH: `${bin}:${process.env.PATH}`, AGENT_TEST_FAIL: "1" }, "agent", "dropped");
    expect(code).not.toBe(0);
    expect(out + err).not.toContain("tsp1_");
    expect(existsSync(join(instance, "agent-dropped.token"))).toBe(false);
    expect(liveTokens("dropped")).toEqual({ live: 0, all: 1 });
  });
});
