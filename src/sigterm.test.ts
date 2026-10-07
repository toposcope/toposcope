import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatSyslog3164 } from "./ingest/syslog-parse";

// `docker compose stop`, an upgrade and a host shutdown send the app SIGTERM.
// In the image bun is process 1, and a process 1 with no handler ignores the
// signal: Docker waits out the grace period and kills it (exit 137). Here the
// app is an ordinary child, where an unhandled SIGTERM kills it at once, so "it
// exits" proves nothing. These tests ask for what only a handler can give: exit
// code 0, and the work in hand finished first.

/** Docker's default grace period is 10s. The app has to be gone well inside it. */
const EXIT_BUDGET_MS = 5_000;
/** How long ClickHouse keeps an insert open after the signal. */
const HOLD_MS = 300;
const HOOK_TIMEOUT_MS = 30_000;
const TOKEN = "sigterm-only";

const entry = join(import.meta.dir, "index.ts");
// Not the repository: bun reads a `.env` from the working directory.
const cwd = mkdtempSync(join(tmpdir(), "toposcope-sigterm-"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

type Reply = { status: number; body: unknown } | { failed: string };
type Exit = { code: number | null; signal: string | null; timedOut: boolean };
const cleanExit: Exit = { code: 0, signal: null, timedOut: false };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what: string, ok: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await ok())) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await sleep(10);
  }
}

/** Answers what boot asks of ClickHouse, and can keep an insert into `logs` open. */
function startClickHouse() {
  const inserted: string[] = [];
  let gate: Promise<void> | null = null;
  let held = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/ping") {
        return new Response("Ok.\n");
      }
      const body = await req.text();
      if ((url.searchParams.get("query") ?? "").startsWith("INSERT INTO logs ")) {
        if (gate) {
          held++;
          await gate;
        }
        for (const line of body.split("\n")) {
          inserted.push((JSON.parse(line) as { message: string }).message);
        }
        return new Response("");
      }
      if (body.startsWith("SELECT version()")) {
        return Response.json({ data: [{ v: "26.3.1.1" }] });
      }
      return Response.json({ data: [] });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    /** Messages of the rows whose insert ClickHouse finished. */
    inserted,
    held: () => held,
    /** Inserts wait from now until the returned function is called. */
    hold(): () => void {
      let open = () => {};
      gate = new Promise((resolve) => {
        open = resolve;
      });
      return () => {
        gate = null;
        open();
      };
    },
    stop: () => server.stop(true),
  };
}

function freeTcpPort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port ?? 0;
  probe.stop(true);
  return port;
}

async function freeUdpPort(): Promise<number> {
  const probe = await Bun.udpSocket({ hostname: "127.0.0.1", port: 0 });
  const port = probe.port;
  probe.close();
  return port;
}

/** The app as the image runs it (`bun run src/index.ts`), on a spare port. */
async function startApp(clickhouseUrl: string, syslogPort = 0) {
  const port = freeTcpPort();
  const child = Bun.spawn([process.execPath, "run", entry], {
    cwd,
    env: {
      ...process.env,
      TOPOSCOPE_DEV: "1",
      TOPOSCOPE_PASSWORD: "sigterm-only",
      TOPOSCOPE_INGEST_TOKEN: TOKEN,
      SQLITE_PATH: ":memory:",
      CLICKHOUSE_URL: clickhouseUrl,
      HOST: "127.0.0.1",
      PORT: String(port),
      SYSLOG_UDP_PORT: String(syslogPort),
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  const base = `http://127.0.0.1:${port}`;
  const running = () => child.exitCode === null && child.signalCode === null;
  try {
    await until("the app to be ready", async () => {
      if (!running()) {
        throw new Error("The app exited during boot");
      }
      try {
        return (await fetch(`${base}/api/health`)).status === 200;
      } catch {
        return false;
      }
    });
  } catch (err) {
    child.kill("SIGKILL");
    throw new Error(`${String(err)}\n${await stderr}`);
  }
  return {
    port,
    running,
    /** One event, on a connection of its own. */
    async ingest(message: string): Promise<Reply> {
      try {
        const res = await fetch(`${base}/api/ingest`, {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ service: "sigterm-test", level: "info", message }),
          keepalive: false,
        });
        const text = await res.text();
        return { status: res.status, body: text.startsWith("{") ? JSON.parse(text) : text };
      } catch (err) {
        return { failed: String(err) };
      }
    },
    async syslogPackets(): Promise<number> {
      const text = await (await fetch(`${base}/api/metrics`)).text();
      return Number(/^toposcope_syslog_packets_total (\d+)$/m.exec(text)?.[1] ?? 0);
    },
    sigterm: () => child.kill("SIGTERM"),
    /** How the app ended. Still up when the budget runs out: killed, `timedOut`. */
    async exit(sentAt: number): Promise<Exit> {
      const left = Math.max(0, EXIT_BUDGET_MS - (performance.now() - sentAt));
      const timedOut = await Promise.race([
        child.exited.then(() => false),
        sleep(left).then(() => true),
      ]);
      if (timedOut) {
        child.kill("SIGKILL");
        await child.exited;
        return { code: null, signal: null, timedOut };
      }
      return { code: child.exitCode, signal: child.signalCode, timedOut };
    },
  };
}

/** What a collector or an open browser tab leaves behind: a connection with no request on it. */
function idleKeepAlive(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    });
    socket.once("data", () => resolve(socket));
    socket.once("error", reject);
  });
}

/** The status line of one more request on a connection that is already open. */
function statusOn(socket: Socket): Promise<string> {
  return new Promise((resolve) => {
    socket.once("data", (chunk) => resolve(chunk.toString().split("\r\n")[0] ?? ""));
    socket.once("close", () => resolve("closed"));
    socket.write("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
  });
}

describe("SIGTERM with nothing in flight", () => {
  let exit: Exit;

  beforeAll(async () => {
    const clickhouse = startClickHouse();
    const app = await startApp(clickhouse.url);
    const idle = await idleKeepAlive(app.port);
    idle.on("error", () => {});
    const sentAt = performance.now();
    app.sigterm();
    exit = await app.exit(sentAt);
    idle.destroy();
    clickhouse.stop();
  }, HOOK_TIMEOUT_MS);

  test("exits 0 well inside the grace period, with an idle keep-alive connection open", () => {
    expect(exit).toEqual(cleanExit);
  });
});

describe("SIGTERM with a request in flight", () => {
  let drainingAfterSignal: boolean;
  let inFlight: Reply;
  let late: Reply | "accepted";
  let onOpenConnection: string;
  let inserted: string[];
  let exit: Exit;

  beforeAll(async () => {
    const clickhouse = startClickHouse();
    const app = await startApp(clickhouse.url);
    const open = await idleKeepAlive(app.port);
    open.on("error", () => {});
    const release = clickhouse.hold();
    const first = app.ingest("in flight");
    await until("the insert to reach ClickHouse", () => clickhouse.held() === 1);

    const sentAt = performance.now();
    app.sigterm();
    await sleep(HOLD_MS);
    drainingAfterSignal = app.running();
    // A request the app took anyway would wait on the same insert.
    late = await Promise.race([
      app.ingest("after the signal"),
      sleep(500).then(() => "accepted" as const),
    ]);
    onOpenConnection = await statusOn(open);
    release();
    inFlight = await first;
    exit = await app.exit(sentAt);
    inserted = [...clickhouse.inserted];
    open.destroy();
    clickhouse.stop();
  }, HOOK_TIMEOUT_MS);

  test("the sender of the request in flight still gets its reply", () => {
    expect(inFlight).toEqual({ status: 200, body: { ingested: 1 } });
  });

  test("takes no new request while it finishes the one in flight", () => {
    // Still up after the signal: it is finishing, not dead.
    expect(drainingAfterSignal).toBe(true);
    expect(late).not.toBe("accepted");
    if (late !== "accepted" && "status" in late) {
      expect(late.status).toBe(503);
    }
    expect(inserted).toEqual(["in flight"]);
  });

  test("a request on a connection that was already open is turned away, not served", () => {
    expect(["HTTP/1.1 503 Service Unavailable", "closed"]).toContain(onOpenConnection);
  });

  test("exits 0 well inside the grace period once that request is answered", () => {
    expect(exit).toEqual(cleanExit);
  });
});

describe("SIGTERM with rows waiting in the syslog queue", () => {
  const messages = ["syslog 1", "syslog 2", "syslog 3", "syslog 4", "syslog 5"];
  let inserted: string[];
  let exit: Exit;

  beforeAll(async () => {
    const clickhouse = startClickHouse();
    const syslogPort = await freeUdpPort();
    const app = await startApp(clickhouse.url, syslogPort);
    const release = clickhouse.hold();
    const udp = await Bun.udpSocket({});
    const send = (message: string) =>
      udp.send(
        formatSyslog3164({
          ts: new Date().toISOString(),
          service: "sigterm-test",
          host: "sigterm-host",
          level: "info",
          message,
          attrs: {},
        }),
        syslogPort,
        "127.0.0.1",
      );
    // The first row's insert stays open in ClickHouse; the other four wait behind it.
    send(messages[0]!);
    await until("the first syslog insert to reach ClickHouse", () => clickhouse.held() === 1);
    for (const message of messages.slice(1)) {
      send(message);
    }
    await until("the app to take every packet", async () => (await app.syslogPackets()) === messages.length);
    udp.close();

    const sentAt = performance.now();
    app.sigterm();
    await sleep(HOLD_MS);
    release();
    exit = await app.exit(sentAt);
    // ClickHouse finishes the insert it already has, whoever is left to hear of it.
    await until("ClickHouse to finish the open insert", () => clickhouse.inserted.length > 0);
    inserted = [...clickhouse.inserted];
    clickhouse.stop();
  }, HOOK_TIMEOUT_MS);

  test("inserts every row the queue holds before it exits 0", () => {
    expect([...inserted].sort()).toEqual(messages);
    expect(exit).toEqual(cleanExit);
  });
});
