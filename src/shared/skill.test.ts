import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

const password = "operator-secret-0f3a9c";
const token = "ingest-secret-7b21d4";
const word = "tscheck0123456789ab";

let home: string;
let server: ReturnType<typeof Bun.serve>;
let reply: unknown = {};
let seen: Array<{ authorization: string | null; q: string | null; range: string | null }> = [];
let checks: Array<{ authorization: string | null; agent: string | null; body: Record<string, unknown> }> = [];

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "toposcope-skill-"));
  writeFileSync(
    join(home, ".env"),
    `CLICKHOUSE_USER=default\nCLICKHOUSE_PASSWORD=clickhouse-secret-55e0\nTOPOSCOPE_PASSWORD=${password}\nTOPOSCOPE_INGEST_TOKEN=${token}\n`,
  );
  // Stands in for the instance's search route, on loopback.
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
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
        authorization: `Basic ${btoa(`toposcope:${password}`)}`,
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

  test("never prints the operator password", async () => {
    reply = found([await exported()]);
    const { out, err } = await run("check", word);
    expect(out + err).not.toContain(password);
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
