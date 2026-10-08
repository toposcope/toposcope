import { afterEach, describe, expect, test } from "bun:test";
import http2 from "node:http2";
import net from "node:net";
import { gzipSync } from "node:zlib";
import { MAX_BODY_BYTES } from "./index";
import {
  encodeGrpcMessage,
  grpcFrame,
  grpcStatusFor,
  otlpGrpcRoutes,
  startOtlpGrpc,
  type OtlpGrpcListener,
} from "./otlp-grpc";

const logs = "/opentelemetry.proto.collector.logs.v1.LogsService/Export";

type Seen = { path: string; method: string; headers: Record<string, string>; body: Uint8Array };
type Reply = {
  http: number | undefined;
  contentType: string | undefined;
  grpcStatus: string | undefined;
  grpcMessage: string | undefined;
  /** The reply message, without its five-byte prefix. Null when there was none. */
  message: Uint8Array | null;
};

let listener: OtlpGrpcListener | undefined;
let seen: Seen[] = [];

afterEach(async () => {
  await listener?.stop();
  listener = undefined;
  seen = [];
});

/** A listener on a free port whose calls are answered by `answer`. */
async function listen(answer: (request: Seen) => Response | Promise<Response>): Promise<number> {
  listener = await startOtlpGrpc(
    async (request) => {
      const call: Seen = {
        path: new URL(request.url).pathname,
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: new Uint8Array(await request.arrayBuffer()),
      };
      seen.push(call);
      return answer(call);
    },
    { port: 0, hostname: "127.0.0.1" },
  );
  return listener!.port;
}

/** One unary call, as a gRPC client makes it. `body` is sent as it is. */
function call(
  port: number,
  path: string,
  body: Uint8Array,
  headers: Record<string, string> = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const client = http2.connect(`http://127.0.0.1:${port}`);
    client.on("error", reject);
    const request = client.request({
      ":method": "POST",
      ":path": path,
      "content-type": "application/grpc",
      te: "trailers",
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
      client.close();
      const bytes = Buffer.concat(chunks);
      const text = (key: string) => {
        const value = trailers[key] ?? head[key];
        return value === undefined ? undefined : String(value);
      };
      resolve({
        http: head[":status"] as number | undefined,
        contentType: head["content-type"] as string | undefined,
        grpcStatus: text("grpc-status"),
        grpcMessage: text("grpc-message"),
        message: bytes.length >= 5 ? new Uint8Array(bytes.subarray(5, 5 + bytes.readUInt32BE(1))) : null,
      });
    });
    request.end(body);
  });
}

const sent = new Uint8Array([0x0a, 0x02, 0x08, 0x01]);
const protobuf = (bytes: Uint8Array = new Uint8Array()) =>
  new Response(Buffer.from(bytes), { headers: { "content-type": "application/x-protobuf" } });

describe("OTLP over gRPC", () => {
  test("each service's export goes to the HTTP route that does its work, as the protobuf it is", async () => {
    const port = await listen(() => protobuf());
    for (const [method, route] of Object.entries(otlpGrpcRoutes)) {
      const reply = await call(port, method, grpcFrame(sent), { authorization: "Bearer the-token" });
      expect(reply.grpcStatus).toBe("0");
      expect(seen.at(-1)).toMatchObject({ path: route, method: "POST" });
      expect(seen.at(-1)!.headers).toMatchObject({
        "content-type": "application/x-protobuf",
        authorization: "Bearer the-token",
      });
      expect([...seen.at(-1)!.body]).toEqual([...sent]);
    }
    expect(Object.values(otlpGrpcRoutes)).toEqual([
      "/v1/logs",
      "/v1/traces",
      "/v1/metrics",
      "/v1development/profiles",
    ]);
  });

  test("full success is an empty reply with status OK", async () => {
    const port = await listen(() => protobuf());
    const reply = await call(port, logs, grpcFrame(sent));
    expect(reply).toMatchObject({ http: 200, contentType: "application/grpc", grpcStatus: "0" });
    expect([...reply.message!]).toEqual([]);
  });

  test("a partial success comes back as the same message the HTTP route answers with", async () => {
    const partial = new Uint8Array([0x0a, 0x04, 0x08, 0x02, 0x12, 0x00]);
    const port = await listen(() => protobuf(partial));
    const reply = await call(port, logs, grpcFrame(sent));
    expect(reply.grpcStatus).toBe("0");
    expect([...reply.message!]).toEqual([...partial]);
  });

  test("a call with no token carries none, and the route's refusal is UNAUTHENTICATED", async () => {
    const port = await listen((request) =>
      request.headers.authorization ? protobuf() : Response.json({ error: "Unauthorized" }, { status: 401 }),
    );
    const reply = await call(port, logs, grpcFrame(sent));
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(reply).toMatchObject({ grpcStatus: "16", grpcMessage: "Unauthorized", message: null });
  });

  test("what the route refuses becomes the status an exporter acts on, with the route's words", async () => {
    let status = 400;
    const port = await listen(() => Response.json({ error: `said ${status}` }, { status }));
    const got: Record<number, string | undefined> = {};
    for (status of [400, 404, 413, 429, 500, 503]) {
      const reply = await call(port, logs, grpcFrame(sent));
      expect(reply.grpcMessage).toBe(`said ${status}`);
      got[status] = reply.grpcStatus;
    }
    // INVALID_ARGUMENT, UNIMPLEMENTED, RESOURCE_EXHAUSTED, UNAVAILABLE, INTERNAL, UNAVAILABLE.
    expect(got).toEqual({ 400: "3", 404: "12", 413: "8", 429: "14", 500: "13", 503: "14" });
    // Busy and stopping are the two an exporter tries again.
    expect(grpcStatusFor(429)).toBe(14);
    expect(grpcStatusFor(503)).toBe(14);
    expect(grpcStatusFor(200)).toBe(0);
  });

  test("a gzipped message reaches the route gzipped, so it is inflated under the same cap", async () => {
    const port = await listen(() => protobuf());
    const zipped = gzipSync(sent);
    const frame = grpcFrame(zipped);
    frame[0] = 1;
    const reply = await call(port, logs, frame, { "grpc-encoding": "gzip" });
    expect(reply.grpcStatus).toBe("0");
    expect(seen[0]!.headers["content-encoding"]).toBe("gzip");
    expect([...seen[0]!.body]).toEqual([...zipped]);
  });

  test("a compression other than gzip is refused before the route sees it", async () => {
    const port = await listen(() => protobuf());
    const frame = grpcFrame(sent);
    frame[0] = 1;
    const reply = await call(port, logs, frame, { "grpc-encoding": "snappy" });
    expect(reply.grpcStatus).toBe("12");
    expect(seen).toEqual([]);
  });

  test("a method that is not an OTLP export is UNIMPLEMENTED", async () => {
    const port = await listen(() => protobuf());
    const reply = await call(port, "/grpc.health.v1.Health/Check", grpcFrame(sent));
    expect(reply.grpcStatus).toBe("12");
    expect(seen).toEqual([]);
  });

  test("a message over the body cap is refused without reaching the route", async () => {
    const port = await listen(() => protobuf());
    const reply = await call(port, logs, grpcFrame(new Uint8Array(MAX_BODY_BYTES + 1)));
    expect(reply.grpcStatus).toBe("8");
    expect(reply.grpcMessage).toContain("too large");
    expect(seen).toEqual([]);
    // One at the cap goes through.
    expect((await call(port, logs, grpcFrame(new Uint8Array(MAX_BODY_BYTES)))).grpcStatus).toBe("0");
  });

  test("a call must carry exactly one whole message", async () => {
    const port = await listen(() => protobuf());
    const two = new Uint8Array([...grpcFrame(sent), ...grpcFrame(sent)]);
    expect((await call(port, logs, two)).grpcStatus).toBe("3");
    expect((await call(port, logs, grpcFrame(sent).subarray(0, 7))).grpcStatus).toBe("3");
    expect((await call(port, logs, new Uint8Array())).grpcStatus).toBe("3");
    expect(seen).toEqual([]);
  });

  test("a request that is not gRPC is not answered as one", async () => {
    const port = await listen(() => protobuf());
    const reply = await call(port, logs, sent, { "content-type": "application/x-protobuf" });
    expect(reply.http).toBe(415);
    expect(reply.grpcStatus).toBeUndefined();
  });

  test("the server says it will not push, or a client built on nghttp2 drops the connection", async () => {
    const port = await listen(() => protobuf());
    const settings = await new Promise<http2.Settings>((resolve, reject) => {
      const client = http2.connect(`http://127.0.0.1:${port}`);
      client.on("error", reject);
      client.on("remoteSettings", (remote) => {
        client.close();
        resolve(remote);
      });
    });
    expect(settings.enablePush).toBe(false);
  });

  test("a message with more than plain ASCII is percent-encoded, as the protocol asks", () => {
    expect(encodeGrpcMessage("Batch too large (max 1024)")).toBe("Batch too large (max 1024)");
    expect(encodeGrpcMessage("100% wrong\n")).toBe("100%25 wrong%0A");
    expect(encodeGrpcMessage("naïve")).toBe("na%C3%AFve");
  });

  test("when the listener stops, a call in flight still gets its reply, and nothing new connects", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const port = await listen(async () => {
      await held;
      return protobuf();
    });
    const inFlight = call(port, logs, grpcFrame(sent));
    while (seen.length === 0) {
      await Bun.sleep(5);
    }
    const stopped = listener!.stop();
    listener = undefined;
    release();
    expect((await inFlight).grpcStatus).toBe("0");
    await stopped;
    // A plain TCP connect: Bun 1.3.11's HTTP/2 client crashes the test runner when it
    // reconnects to a port this process has just stopped listening on.
    const refused = await new Promise<string>((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve("connected");
      });
      socket.once("error", (err: NodeJS.ErrnoException) => resolve(err.code ?? "error"));
    });
    expect(refused).toBe("ECONNREFUSED");
  });

  test("OTLP_GRPC_PORT=0 turns the listener off", async () => {
    const before = process.env.OTLP_GRPC_PORT;
    process.env.OTLP_GRPC_PORT = "0";
    try {
      expect(await startOtlpGrpc(() => protobuf())).toBeUndefined();
    } finally {
      if (before === undefined) {
        delete process.env.OTLP_GRPC_PORT;
      } else {
        process.env.OTLP_GRPC_PORT = before;
      }
    }
  });
});
