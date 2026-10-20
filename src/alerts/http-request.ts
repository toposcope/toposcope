import { lookup } from "node:dns/promises";
import { isIP, Socket, connect as tcpConnect } from "node:net";
import { checkServerIdentity, connect as tlsConnect, type TLSSocket } from "node:tls";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { httpTimeoutMs, maxReadBody, type HttpMethod } from "../shared/http-check";

/**
 * One HTTP(S) request from this node (#178), over a socket of its own so a run can say where
 * its time went (dns, connect, tls, wait, body) and what certificate answered, as 18r draws.
 * HTTP/1.1 only, `Connection: close`, never a redirect followed, and a TLS certificate that is
 * not trusted for the host ends it before any header is sent.
 */

export type HttpTimings = {
  dns: number;
  connect: number;
  /** Null over http. */
  tls: number | null;
  /** From the request sent to its first byte back. */
  wait: number;
  body: number;
  total: number;
};

export type HttpCert = {
  /** The name it was issued to. */
  subject: string;
  issuer: string;
  /** ISO. */
  valid_to: string;
};

export type HttpExchange =
  | {
      ok: true;
      status: number;
      status_text: string;
      http_version: string;
      headers: Array<[string, string]>;
      body: string;
      /** Bytes on the wire for the body, before any decoding. */
      body_bytes: number;
      /** Read only up to 1 MB. */
      truncated: boolean;
      timings: HttpTimings;
      cert: HttpCert | null;
    }
  | {
      ok: false;
      /** `connect ECONNREFUSED`, `timeout after 10s`, `certificate has expired`. */
      error: string;
      timings: HttpTimings;
      cert: HttpCert | null;
    };

export type HttpRequestInput = {
  url: string;
  method: HttpMethod;
  headers: ReadonlyArray<readonly [string, string]>;
  body: string | null;
  timeoutMs?: number;
  /** Trusted CAs besides the system's, for tests. */
  ca?: string;
};

const maxHeaderBytes = 64 * 1024;
const userAgent = "toposcope-monitor/1";

class RunError extends Error {}

export function tlsError(code: string | Error | undefined): string {
  const c = typeof code === "string" ? code : (code as { code?: string } | undefined)?.code ?? code?.message ?? "";
  switch (c) {
    case "CERT_HAS_EXPIRED":
      return "certificate has expired";
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
      return "certificate is self-signed";
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "UNABLE_TO_GET_ISSUER_CERT_LOCALLY":
    case "UNABLE_TO_GET_ISSUER_CERT":
      return "certificate is not trusted";
    case "CERT_NOT_YET_VALID":
      return "certificate is not valid yet";
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      return "certificate is not for this host";
    default:
      return c ? `certificate: ${c}` : "certificate is not trusted";
  }
}

export function netError(err: unknown, host: string): string {
  const e = err as { code?: string; message?: string };
  switch (e?.code) {
    case "ECONNREFUSED":
      return "connect ECONNREFUSED";
    case "ECONNRESET":
      return "connection reset";
    case "EHOSTUNREACH":
      return "connect EHOSTUNREACH";
    case "ENETUNREACH":
      return "connect ENETUNREACH";
    case "ENOTFOUND":
    case "EAI_NONAME":
    case "EAI_AGAIN":
      return `dns ${host} not found`;
    default:
      return (e?.code ? `${e.code}` : (e?.message ?? String(err))).slice(0, 200);
  }
}

function certOf(socket: TLSSocket): HttpCert | null {
  const peer = socket.getPeerCertificate();
  if (!peer || !peer.valid_to) {
    return null;
  }
  const to = Date.parse(peer.valid_to);
  const name = (v: unknown) => (Array.isArray(v) ? String(v[0] ?? "") : typeof v === "string" ? v : "");
  return {
    subject: name(peer.subject?.CN),
    issuer: name(peer.issuer?.O) || name(peer.issuer?.CN),
    valid_to: Number.isFinite(to) ? new Date(to).toISOString() : peer.valid_to,
  };
}

/** The addresses to try, IPv4 first, as a browser would fall back. */
export async function addresses(host: string): Promise<string[]> {
  if (isIP(host)) {
    return [host];
  }
  const all = await lookup(host, { all: true });
  return [...all.filter((a) => a.family === 4), ...all.filter((a) => a.family !== 4)].map((a) => a.address);
}

export function openTcp(address: string, port: number, held: (s: Socket) => void): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = tcpConnect({ host: address, port });
    held(socket);
    socket.once("connect", () => {
      socket.removeAllListeners("error");
      resolve(socket);
    });
    socket.once("error", (err) => {
      socket.destroy();
      reject(err);
    });
  });
}

/** TLS over a connected socket. Its certificate is checked by the caller, not here. */
export function openTls(
  socket: Socket,
  servername: string | undefined,
  ca: string | undefined,
  alpn: string[] | null = ["http/1.1"],
): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const secure = tlsConnect({
      socket,
      servername,
      rejectUnauthorized: false,
      ...(alpn ? { ALPNProtocols: alpn } : {}),
      ...(ca ? { ca } : {}),
    });
    secure.once("secureConnect", () => {
      secure.removeAllListeners("error");
      resolve(secure);
    });
    secure.once("error", (err) => {
      secure.destroy();
      reject(err);
    });
  });
}

function requestHead(input: HttpRequestInput, url: URL): string {
  // `host` leaves out a default port and keeps an IPv6 address in brackets.
  const lines = [`${input.method} ${url.pathname || "/"}${url.search} HTTP/1.1`, `Host: ${url.host}`];
  const own = new Set(input.headers.map(([k]) => k.toLowerCase()));
  if (!own.has("user-agent")) {
    lines.push(`User-Agent: ${userAgent}`);
  }
  if (!own.has("accept")) {
    lines.push("Accept: */*");
  }
  lines.push("Accept-Encoding: gzip, deflate, br");
  lines.push("Connection: close");
  for (const [k, v] of input.headers) {
    lines.push(`${k}: ${v}`);
  }
  if (input.body !== null && input.method === "POST") {
    if (!own.has("content-type")) {
      lines.push("Content-Type: application/json");
    }
    lines.push(`Content-Length: ${Buffer.byteLength(input.body)}`);
  } else if (input.method === "POST") {
    lines.push("Content-Length: 0");
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

type Head = { version: string; status: number; text: string; headers: Array<[string, string]> };

function parseHead(raw: string): Head {
  const lines = raw.split("\r\n");
  const m = /^HTTP\/(\d(?:\.\d)?) (\d{3})(?: (.*))?$/.exec(lines[0] ?? "");
  if (!m) {
    throw new RunError("not an HTTP response");
  }
  const headers: Array<[string, string]> = [];
  for (const line of lines.slice(1)) {
    const at = line.indexOf(":");
    if (at <= 0) {
      continue;
    }
    headers.push([line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim()]);
  }
  return { version: `HTTP/${m[1]}`, status: Number(m[2]), text: m[3] ?? "", headers };
}

function header(head: Head, name: string): string | null {
  const found = head.headers.find(([k]) => k === name);
  return found ? found[1] : null;
}

/** A chunked body, decoded as far as it has arrived. `done` once the last chunk is in. */
function dechunk(buf: Buffer): { body: Buffer; done: boolean } {
  const parts: Buffer[] = [];
  let i = 0;
  for (;;) {
    const eol = buf.indexOf("\r\n", i);
    if (eol < 0) {
      return { body: Buffer.concat(parts), done: false };
    }
    const size = Number.parseInt(buf.subarray(i, eol).toString("latin1").split(";")[0]!.trim(), 16);
    if (!Number.isFinite(size)) {
      throw new RunError("a chunked body is not written right");
    }
    if (size === 0) {
      return { body: Buffer.concat(parts), done: true };
    }
    if (buf.length < eol + 2 + size) {
      parts.push(buf.subarray(eol + 2));
      return { body: Buffer.concat(parts), done: false };
    }
    parts.push(buf.subarray(eol + 2, eol + 2 + size));
    i = eol + 2 + size + 2;
  }
}

function decode(body: Buffer, encoding: string | null): Buffer {
  const enc = (encoding ?? "").toLowerCase().trim();
  const opts = { maxOutputLength: maxReadBody };
  try {
    if (enc === "gzip" || enc === "x-gzip") return gunzipSync(body, opts);
    if (enc === "deflate") return inflateSync(body, opts);
    if (enc === "br") return brotliDecompressSync(body, opts);
  } catch {
    // A body cut at 1 MB, or one over 1 MB once inflated, reads as far as it goes.
    return Buffer.alloc(0);
  }
  return body;
}

/** One request, start to end, in at most 10s. */
export async function runHttpRequest(input: HttpRequestInput): Promise<HttpExchange> {
  const timeoutMs = input.timeoutMs ?? httpTimeoutMs;
  const t0 = performance.now();
  const at = () => performance.now() - t0;
  const timings: HttpTimings = { dns: 0, connect: 0, tls: null, wait: 0, body: 0, total: 0 };
  let cert: HttpCert | null = null;
  let socket: Socket | TLSSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const url = new URL(input.url);
  const https = url.protocol === "https:";
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const port = Number(url.port || (https ? 443 : 80));

  let over = false;
  /** After the 10s are up, a step still in flight stops where it is and sends nothing. */
  const still = <T extends Socket | null>(s: T): T => {
    if (over) {
      s?.destroy();
      throw new RunError("timeout");
    }
    return s;
  };

  const run = async (): Promise<HttpExchange> => {
    let mark = 0;
    let addrs: string[];
    try {
      addrs = await addresses(hostname);
    } catch (err) {
      throw new RunError(netError(err, hostname));
    }
    still(null);
    timings.dns = at() - mark;
    mark = at();
    let tcp: Socket | null = null;
    let lastErr: unknown = null;
    for (const address of addrs) {
      try {
        // Held from the start, so the 10s can close a connect that never answers.
        tcp = await openTcp(address, port, (held) => (socket = held));
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!tcp) {
      throw new RunError(netError(lastErr, hostname));
    }
    socket = still(tcp);
    timings.connect = at() - mark;
    mark = at();
    if (https) {
      let secure: TLSSocket;
      try {
        secure = await openTls(tcp, isIP(hostname) ? undefined : hostname, input.ca);
      } catch (err) {
        throw new RunError(tlsError(err as Error));
      }
      socket = still(secure);
      timings.tls = at() - mark;
      mark = at();
      cert = certOf(secure);
      if (!secure.authorized) {
        throw new RunError(tlsError(secure.authorizationError));
      }
      const peer = secure.getPeerCertificate();
      // By name or by address: the certificate must be for what the URL says.
      if (!peer || checkServerIdentity(hostname, peer)) {
        throw new RunError(tlsError("ERR_TLS_CERT_ALTNAME_INVALID"));
      }
    }
    const s = socket as Socket;
    const sentAt = at();
    return await new Promise<HttpExchange>((resolve, reject) => {
      let buf: Buffer = Buffer.alloc(0);
      let head: Head | null = null;
      let bodyStart = 0;
      let firstByte = -1;
      let settled = false;
      const finish = (truncated: boolean) => {
        if (settled || !head) {
          return;
        }
        settled = true;
        const end = at();
        timings.wait = firstByte - sentAt;
        timings.body = end - (sentAt + timings.wait);
        let raw: Buffer = buf.subarray(bodyStart);
        let done = true;
        if ((header(head, "transfer-encoding") ?? "").toLowerCase().includes("chunked")) {
          const chunked = dechunk(raw);
          raw = chunked.body;
          done = chunked.done;
        }
        const length = Number(header(head, "content-length"));
        if (Number.isFinite(length) && length >= 0 && raw.length > length) {
          raw = raw.subarray(0, length);
        }
        const decoded = decode(raw, header(head, "content-encoding"));
        const cut = decoded.length > maxReadBody;
        s.destroy();
        resolve({
          ok: true,
          status: head.status,
          status_text: head.text,
          http_version: head.version,
          headers: head.headers,
          body: decoded.subarray(0, maxReadBody).toString("utf8"),
          body_bytes: raw.length,
          truncated: truncated || cut || !done,
          timings,
          cert,
        });
      };
      const fail = (message: string) => {
        if (settled) {
          return;
        }
        settled = true;
        s.destroy();
        reject(new RunError(message));
      };
      /** Whether all of the body is in, by its framing. */
      const complete = (): boolean => {
        if (!head) {
          return false;
        }
        const noBody =
          input.method === "HEAD" || head.status === 204 || head.status === 304 || (head.status >= 100 && head.status < 200);
        if (noBody) {
          return true;
        }
        const raw = buf.subarray(bodyStart);
        if ((header(head, "transfer-encoding") ?? "").toLowerCase().includes("chunked")) {
          return dechunk(raw).done;
        }
        const length = Number(header(head, "content-length") ?? NaN);
        return Number.isFinite(length) && raw.length >= length;
      };
      s.on("data", (chunk: Buffer) => {
        if (firstByte < 0) {
          firstByte = at();
        }
        buf = Buffer.concat([buf, chunk]);
        try {
          while (!head) {
            const end = buf.indexOf("\r\n\r\n");
            if (end < 0) {
              if (buf.length > maxHeaderBytes) {
                fail("response headers are over 64 KB");
              }
              return;
            }
            const parsed = parseHead(buf.subarray(0, end).toString("latin1"));
            // A 100 Continue is not the response; the next head is.
            if (parsed.status >= 100 && parsed.status < 200 && parsed.status !== 101) {
              buf = buf.subarray(end + 4);
              continue;
            }
            head = parsed;
            bodyStart = end + 4;
          }
          if (complete()) {
            finish(false);
          } else if (buf.length - bodyStart > maxReadBody) {
            finish(true);
          }
        } catch (err) {
          fail(err instanceof RunError ? err.message : String(err));
        }
      });
      s.on("end", () => (head ? finish(false) : fail("closed before a response")));
      s.on("close", () => (head ? finish(false) : fail("closed before a response")));
      s.on("error", (err) => (head ? finish(true) : fail(netError(err, hostname))));
      s.write(requestHead(input, url));
      if (input.method === "POST" && input.body) {
        s.write(input.body);
      }
    });
  };

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      over = true;
      reject(new RunError(`timeout after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
  });
  try {
    const out = await Promise.race([run(), timeout]);
    out.timings.total = at();
    return out;
  } catch (err) {
    (socket as Socket | null)?.destroy();
    timings.total = at();
    return {
      ok: false,
      error: err instanceof RunError ? err.message : netError(err, hostname),
      timings,
      cert,
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
