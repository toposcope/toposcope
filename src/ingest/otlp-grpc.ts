import http2, {
  type Http2Server,
  type IncomingHttpHeaders,
  type ServerHttp2Session,
  type ServerHttp2Stream,
} from "node:http2";
import { MAX_BODY_BYTES } from "./index";

/**
 * OTLP over gRPC. Several exporters send gRPC unless told otherwise, and gRPC
 * needs HTTP/2, which the main listener does not speak; so this is a second
 * listener. It holds no logic of its own: each call is handed to the HTTP
 * route that already does that signal's work, as the protobuf request it is,
 * and the route's answer is sent back as the call's reply. The token, the
 * caps, the counts and the partial-success message are therefore the same.
 */

/** OTLP's four services, and the HTTP route that does each one's work. */
export const otlpGrpcRoutes: Readonly<Record<string, string>> = {
  "/opentelemetry.proto.collector.logs.v1.LogsService/Export": "/v1/logs",
  "/opentelemetry.proto.collector.trace.v1.TraceService/Export": "/v1/traces",
  "/opentelemetry.proto.collector.metrics.v1.MetricsService/Export": "/v1/metrics",
  "/opentelemetry.proto.collector.profiles.v1development.ProfilesService/Export":
    "/v1development/profiles",
};

/** 4317 is left to a collector on the same host: the packaged Vector config listens there. */
export const defaultOtlpGrpcPort = 4319;

const OK = 0;
const INVALID_ARGUMENT = 3;
const PERMISSION_DENIED = 7;
const RESOURCE_EXHAUSTED = 8;
const UNIMPLEMENTED = 12;
const INTERNAL = 13;
const UNAVAILABLE = 14;
const UNAUTHENTICATED = 16;

/**
 * The gRPC status an HTTP answer becomes. An exporter tries again after
 * UNAVAILABLE, which is what busy and stopping are, and not after the others.
 */
export function grpcStatusFor(httpStatus: number): number {
  if (httpStatus >= 200 && httpStatus < 300) {
    return OK;
  }
  switch (httpStatus) {
    case 400:
      return INVALID_ARGUMENT;
    case 401:
      return UNAUTHENTICATED;
    case 403:
      return PERMISSION_DENIED;
    case 404:
      return UNIMPLEMENTED;
    case 413:
      return RESOURCE_EXHAUSTED;
    case 429:
    case 502:
    case 503:
    case 504:
      return UNAVAILABLE;
    default:
      return INTERNAL;
  }
}

/** gRPC carries a message in a header: bytes outside printable ASCII, and `%`, are percent-encoded. */
export function encodeGrpcMessage(text: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(text)) {
    out +=
      byte >= 0x20 && byte <= 0x7e && byte !== 0x25
        ? String.fromCharCode(byte)
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** A message as gRPC frames it: a flag for compression, its length, then its bytes. */
export function grpcFrame(message: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + message.byteLength);
  new DataView(out.buffer).setUint32(1, message.byteLength);
  out.set(message, 5);
  return out;
}

/** 0 turns the listener off. */
function grpcPort(): number {
  const raw = process.env.OTLP_GRPC_PORT;
  if (raw === undefined || raw.trim() === "") {
    return defaultOtlpGrpcPort;
  }
  const port = Number(raw);
  return Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : defaultOtlpGrpcPort;
}

function fail(stream: ServerHttp2Stream, status: number, message: string): void {
  if (stream.destroyed || stream.headersSent) {
    return;
  }
  // A call that fails before any message is answered with its status in the headers.
  stream.respond(
    {
      ":status": 200,
      "content-type": "application/grpc",
      "grpc-status": String(status),
      "grpc-message": encodeGrpcMessage(message.slice(0, 500)),
    },
    { endStream: true },
  );
}

/** The call's bytes, or null once they pass the cap. */
function readCall(stream: ServerHttp2Stream, maxBytes: number): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let over = false;
    stream.on("data", (chunk: Uint8Array) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => {
      if (over) {
        resolve(null);
        return;
      }
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      resolve(out);
    });
    stream.on("error", reject);
    stream.on("aborted", () => reject(new Error("call aborted")));
  });
}

async function errorText(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string") {
      return parsed.error;
    }
  } catch {
    // Not JSON: say what the route said.
  }
  return text.length > 0 ? text : `HTTP ${response.status}`;
}

type Handle = (request: Request) => Response | Promise<Response>;

async function call(
  stream: ServerHttp2Stream,
  headers: IncomingHttpHeaders,
  handle: Handle,
): Promise<void> {
  const contentType = String(headers["content-type"] ?? "");
  if (headers[":method"] !== "POST" || !contentType.startsWith("application/grpc")) {
    stream.respond({ ":status": 415 }, { endStream: true });
    return;
  }
  const route = otlpGrpcRoutes[String(headers[":path"] ?? "")];
  if (!route) {
    fail(stream, UNIMPLEMENTED, "Not an OTLP export method");
    return;
  }
  // One message to a call, under the same cap as an HTTP body, plus its five-byte prefix.
  const body = await readCall(stream, MAX_BODY_BYTES + 5);
  if (body === null) {
    fail(stream, RESOURCE_EXHAUSTED, `Body too large (max ${MAX_BODY_BYTES} bytes)`);
    return;
  }
  if (body.byteLength < 5) {
    fail(stream, INVALID_ARGUMENT, "Empty body");
    return;
  }
  const compressed = body[0] === 1;
  const length = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(1);
  if (body[0]! > 1 || 5 + length !== body.byteLength) {
    fail(stream, INVALID_ARGUMENT, "Expected one message");
    return;
  }
  if (compressed && headers["grpc-encoding"] !== "gzip") {
    fail(stream, UNIMPLEMENTED, "Unsupported compression; send gzip or none");
    return;
  }

  const requestHeaders = new Headers({ "content-type": "application/x-protobuf" });
  if (compressed) {
    requestHeaders.set("content-encoding", "gzip");
  }
  if (typeof headers.authorization === "string") {
    requestHeaders.set("authorization", headers.authorization);
  }
  const response = await handle(
    new Request(`http://otlp-grpc${route}`, {
      method: "POST",
      headers: requestHeaders,
      body: Buffer.from(body.subarray(5)),
    }),
  );
  if (stream.destroyed) {
    return;
  }
  const status = grpcStatusFor(response.status);
  if (status !== OK) {
    fail(stream, status, await errorText(response));
    return;
  }
  // The route answers a protobuf request with the Export response itself; empty is full success.
  const protobuf = (response.headers.get("content-type") ?? "").includes("application/x-protobuf");
  const reply = protobuf ? new Uint8Array(await response.arrayBuffer()) : new Uint8Array();
  stream.respond(
    { ":status": 200, "content-type": "application/grpc", "grpc-accept-encoding": "identity,gzip" },
    { waitForTrailers: true },
  );
  stream.once("wantTrailers", () => stream.sendTrailers({ "grpc-status": String(OK) }));
  stream.end(grpcFrame(reply));
}

export type OtlpGrpcListener = {
  port: number;
  /** Takes no new connections and resolves once every call in flight has its reply. */
  stop: () => Promise<void>;
};

/**
 * Starts the listener and hands each call to `handle` as an HTTP request to
 * the matching OTLP route. Resolves to nothing when the port is 0 or taken.
 */
export function startOtlpGrpc(
  handle: Handle,
  opts: { port?: number; hostname?: string } = {},
): Promise<OtlpGrpcListener | undefined> {
  const port = opts.port ?? grpcPort();
  if (port === 0 && opts.port === undefined) {
    return Promise.resolve(undefined);
  }
  const hostname = opts.hostname ?? process.env.HOST ?? "0.0.0.0";
  // Bun's server would otherwise say it may push, which a server must not say:
  // a client built on nghttp2, such as Node's gRPC exporter, drops the connection.
  const server: Http2Server = http2.createServer({ settings: { enablePush: false } });
  const sessions = new Set<ServerHttp2Session>();
  server.on("session", (session) => {
    sessions.add(session);
    session.on("close", () => sessions.delete(session));
    // A client that goes away mid-call is its own business.
    session.on("error", () => undefined);
  });
  /** Calls that have not been answered yet, and who is waiting for there to be none. */
  let inFlight = 0;
  let whenIdle: (() => void) | undefined;
  server.on("stream", (raw, headers) => {
    const stream = raw as ServerHttp2Stream;
    inFlight += 1;
    stream.once("close", () => {
      inFlight -= 1;
      if (inFlight === 0) {
        whenIdle?.();
      }
    });
    stream.on("error", () => undefined);
    void call(stream, headers, handle).catch((err) => {
      if (!stream.destroyed) {
        console.error("OTLP gRPC call failed", err);
        fail(stream, INTERNAL, "Internal error");
      }
    });
  });

  return new Promise((resolve) => {
    server.once("error", (err) => {
      console.error("OTLP gRPC listen failed", err);
      resolve(undefined);
    });
    server.listen(port, hostname, () => {
      const address = server.address();
      const bound = typeof address === "object" && address ? address.port : port;
      console.error(`OTLP gRPC listening on ${hostname}:${bound}`);
      resolve({
        port: bound,
        stop: async () => {
          server.close();
          // Tells each client to open nothing new here; the calls in flight go on.
          for (const session of sessions) {
            session.close();
          }
          if (inFlight > 0) {
            await new Promise<void>((idle) => {
              const timer = setTimeout(idle, 5_000);
              whenIdle = () => {
                clearTimeout(timer);
                idle();
              };
            });
          }
          // A session told to close does so once its last reply is written. One that
          // lingers is an exporter holding its connection open; it is not waited for.
          const deadline = Date.now() + 500;
          while (sessions.size > 0 && Date.now() < deadline) {
            await new Promise((tick) => setTimeout(tick, 10));
          }
          for (const session of sessions) {
            session.destroy();
          }
        },
      });
    });
  });
}
