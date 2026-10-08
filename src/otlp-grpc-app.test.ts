import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import http2 from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { grpcFrame } from "./ingest/otlp-grpc";
import { encodeOtlpMetricsProtobuf } from "./ingest/otlp-metrics-protobuf";
import { encodeOtlpProtobuf } from "./ingest/otlp-protobuf";
import { decodeOtlpReply } from "./ingest/otlp-reply";
import { encodeOtlpTracesProtobuf } from "./ingest/otlp-traces-protobuf";

// OTLP over gRPC through the app as the image runs it: the token, the caps and
// the replies have to be the ones the HTTP routes give, and a call in flight
// has to be answered when the app is told to stop.

const TOKEN = "grpc-only";
const HOOK_TIMEOUT_MS = 30_000;
const EXIT_BUDGET_MS = 5_000;
const entry = join(import.meta.dir, "index.ts");
// Not the repository: bun reads a `.env` from the working directory.
const cwd = mkdtempSync(join(tmpdir(), "toposcope-grpc-"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

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

/** Answers what boot asks of ClickHouse, keeps what is inserted, and can hold an insert open. */
function startClickHouse() {
  const inserted: Record<string, Array<Record<string, unknown>>> = {};
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
      const table = (url.searchParams.get("query") ?? "").match(/^INSERT INTO (\w+) /)?.[1];
      if (table) {
        if (gate) {
          held++;
          await gate;
        }
        (inserted[table] ??= []).push(
          ...body.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>),
        );
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
    inserted,
    held: () => held,
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

async function startApp(clickhouseUrl: string) {
  const port = freeTcpPort();
  const grpcPort = freeTcpPort();
  const child = Bun.spawn([process.execPath, "run", entry], {
    cwd,
    env: {
      ...process.env,
      TOPOSCOPE_DEV: "1",
      TOPOSCOPE_PASSWORD: "grpc-only-operator",
      TOPOSCOPE_INGEST_TOKEN: TOKEN,
      SQLITE_PATH: ":memory:",
      CLICKHOUSE_URL: clickhouseUrl,
      HOST: "127.0.0.1",
      PORT: String(port),
      SYSLOG_UDP_PORT: "0",
      OTLP_GRPC_PORT: String(grpcPort),
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  try {
    await until("the app to be ready", async () => {
      if (child.exitCode !== null) {
        throw new Error("The app exited during boot");
      }
      try {
        return (await fetch(`http://127.0.0.1:${port}/api/health`)).status === 200;
      } catch {
        return false;
      }
    });
  } catch (err) {
    child.kill("SIGKILL");
    throw new Error(`${String(err)}\n${await stderr}`);
  }
  return {
    grpcPort,
    sigterm: () => child.kill("SIGTERM"),
    async exit(sentAt: number): Promise<{ code: number | null; timedOut: boolean }> {
      const left = Math.max(0, EXIT_BUDGET_MS - (performance.now() - sentAt));
      const timedOut = await Promise.race([child.exited.then(() => false), sleep(left).then(() => true)]);
      if (timedOut) {
        child.kill("SIGKILL");
        await child.exited;
      }
      return { code: child.exitCode, timedOut };
    },
    kill: () => child.kill("SIGKILL"),
  };
}

type Reply = { status: string | undefined; message: string | undefined; body: Uint8Array | null };

/** One export call on `session`, as a gRPC exporter makes it. */
function exportOn(
  session: http2.ClientHttp2Session,
  service: string,
  message: Uint8Array,
  headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` },
  compressed = false,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = session.request({
      ":method": "POST",
      ":path": `/opentelemetry.proto.collector.${service}/Export`,
      "content-type": "application/grpc",
      te: "trailers",
      ...(compressed ? { "grpc-encoding": "gzip" } : {}),
      ...headers,
    });
    let head: Record<string, unknown> = {};
    let trailers: Record<string, unknown> = {};
    const chunks: Buffer[] = [];
    request.on("response", (h) => (head = h));
    request.on("trailers", (t) => (trailers = t));
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("error", reject);
    request.on("end", () => {
      const bytes = Buffer.concat(chunks);
      const text = (key: string) => {
        const value = trailers[key] ?? head[key];
        return value === undefined ? undefined : decodeURIComponent(String(value));
      };
      resolve({
        status: text("grpc-status"),
        message: text("grpc-message"),
        body: bytes.length >= 5 ? new Uint8Array(bytes.subarray(5)) : null,
      });
    });
    const frame = grpcFrame(compressed ? gzipSync(message) : message);
    frame[0] = compressed ? 1 : 0;
    request.end(frame);
  });
}

const str = (key: string, value: string) => ({ key, value: { stringValue: value } });
const logsRequest = (messages: string[], attributes: object[] = []) =>
  encodeOtlpProtobuf({
    resourceLogs: [
      {
        resource: { attributes: [str("service.name", "grpc-test")] },
        scopeLogs: [
          {
            logRecords: messages.map((message) => ({
              timeUnixNano: String(Date.now() * 1_000_000),
              severityText: "INFO",
              body: { stringValue: message },
              attributes,
            })),
          },
        ],
      },
    ],
  });

describe("OTLP over gRPC, through the app", () => {
  let clickhouse: ReturnType<typeof startClickHouse>;
  let app: Awaited<ReturnType<typeof startApp>>;
  let session: http2.ClientHttp2Session;

  beforeAll(async () => {
    clickhouse = startClickHouse();
    app = await startApp(clickhouse.url);
    session = http2.connect(`http://127.0.0.1:${app.grpcPort}`);
    session.on("error", () => {});
  }, HOOK_TIMEOUT_MS);

  afterAll(() => {
    session.destroy();
    app.kill();
    clickhouse.stop();
  });

  test("a log export with the ingest token is stored, and answered with an empty reply", async () => {
    const reply = await exportOn(session, "logs.v1.LogsService", logsRequest(["over grpc"]));
    expect(reply.status).toBe("0");
    expect([...reply.body!]).toEqual([]);
    expect(clickhouse.inserted.logs!.map((row) => [row.service, row.message])).toEqual([["grpc-test", "over grpc"]]);
  });

  test("a span and a metric are stored the same way", async () => {
    const now = Date.now();
    const spans = await exportOn(
      session,
      "trace.v1.TraceService",
      encodeOtlpTracesProtobuf({
        resourceSpans: [
          {
            resource: { attributes: [str("service.name", "grpc-test")] },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: "aabbccddeeff00112233445566778899",
                    spanId: "1122334455667788",
                    name: "POST /pay",
                    startTimeUnixNano: String(now * 1_000_000),
                    endTimeUnixNano: String((now + 12) * 1_000_000),
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    expect(spans.status).toBe("0");
    expect(clickhouse.inserted.spans!.map((row) => row.name)).toEqual(["POST /pay"]);

    const metrics = await exportOn(
      session,
      "metrics.v1.MetricsService",
      encodeOtlpMetricsProtobuf({
        resourceMetrics: [
          {
            resource: { attributes: [str("service.name", "grpc-test")] },
            scopeMetrics: [
              { metrics: [{ name: "grpc.test.level", gauge: { dataPoints: [{ timeUnixNano: String(now * 1_000_000), asDouble: 7 }] } }] },
            ],
          },
        ],
      }),
    );
    expect(metrics.status).toBe("0");
    expect(clickhouse.inserted.metrics!.map((row) => [row.name, row.value])).toEqual([["grpc.test.level", 7]]);
  });

  test("a gzipped export is stored too", async () => {
    const reply = await exportOn(session, "logs.v1.LogsService", logsRequest(["zipped"]), undefined, true);
    expect(reply.status).toBe("0");
    expect(clickhouse.inserted.logs!.map((row) => row.message)).toContain("zipped");
  });

  test("no token, or one that was never issued, is UNAUTHENTICATED and nothing is stored", async () => {
    const before = clickhouse.inserted.logs!.length;
    const none = await exportOn(session, "logs.v1.LogsService", logsRequest(["no token"]), {});
    const wrong = await exportOn(session, "logs.v1.LogsService", logsRequest(["wrong token"]), {
      authorization: "Bearer never-issued",
    });
    expect(none).toMatchObject({ status: "16", message: "Unauthorized" });
    expect(wrong.status).toBe("16");
    expect(clickhouse.inserted.logs).toHaveLength(before);
  });

  test("the record cap is the HTTP route's, in the HTTP route's words", async () => {
    const reply = await exportOn(
      session,
      "logs.v1.LogsService",
      logsRequest(Array.from({ length: 1_025 }, (_, i) => `row ${i}`)),
    );
    expect(reply).toMatchObject({ status: "3", message: "Batch too large (max 1024)" });
  });

  test("what a stored row lost comes back as the reply's partial success", async () => {
    const reply = await exportOn(
      session,
      "logs.v1.LogsService",
      logsRequest(["kept, less one attribute"], [str("not a name", "x")]),
    );
    expect(reply.status).toBe("0");
    const partial = decodeOtlpReply(reply.body!);
    expect(partial.rejected).toBe(0);
    expect(partial.errorMessage).toBe("attributes under a name that cannot be stored: cut on 1");
  });
});

describe("SIGTERM with a gRPC call in flight", () => {
  let inFlight: Reply;
  let exit: { code: number | null; timedOut: boolean };
  let stored: unknown[];

  beforeAll(async () => {
    const clickhouse = startClickHouse();
    const app = await startApp(clickhouse.url);
    // An exporter keeps its connection open between exports.
    const idle = http2.connect(`http://127.0.0.1:${app.grpcPort}`);
    idle.on("error", () => {});
    const session = http2.connect(`http://127.0.0.1:${app.grpcPort}`);
    session.on("error", () => {});
    const release = clickhouse.hold();
    const call = exportOn(session, "logs.v1.LogsService", logsRequest(["in flight over grpc"]));
    await until("the insert to reach ClickHouse", () => clickhouse.held() === 1);

    const sentAt = performance.now();
    app.sigterm();
    await sleep(300);
    release();
    inFlight = await call;
    exit = await app.exit(sentAt);
    stored = (clickhouse.inserted.logs ?? []).map((row) => row.message);
    session.destroy();
    idle.destroy();
    clickhouse.stop();
  }, HOOK_TIMEOUT_MS);

  test("the exporter still gets its reply, and the row is stored", () => {
    expect(inFlight.status).toBe("0");
    expect(stored).toEqual(["in flight over grpc"]);
  });

  test("the app exits 0 well inside the grace period, with an idle gRPC connection open", () => {
    expect(exit).toEqual({ code: 0, timedOut: false });
  });
});
