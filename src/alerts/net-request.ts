import { isIP, type Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import { httpTimeoutMs } from "../shared/http-check";
import type { NetCertSeen, Starttls } from "../shared/net-check";
import { addresses, netError, openTcp, openTls, tlsError } from "./http-request";

/**
 * One TCP or certificate run from this node (#180): connect to host:port, and for a certificate
 * monitor go on to a TLS handshake there (after STARTTLS on SMTP, IMAP or POP3 when asked), read
 * the certificate, and close. Nothing else is sent. It says where its time went (dns, connect,
 * starttls, tls), as the HTTP(S) run does.
 */

export type NetTimings = {
  dns: number;
  connect: number;
  /** Null without STARTTLS. */
  starttls: number | null;
  /** Null on a TCP monitor. */
  tls: number | null;
  total: number;
};

export type NetExchange =
  | {
      ok: true;
      /** The address that took the connection. */
      address: string;
      /** A mail server's greeting before STARTTLS: `220 smtp.agental.dev ESMTP`. */
      greeting: string | null;
      timings: NetTimings;
      cert: NetCertSeen | null;
    }
  | {
      ok: false;
      /** `connect ECONNREFUSED`, `timeout after 10s`, `STARTTLS refused: 454 TLS not available`. */
      error: string;
      address: string | null;
      greeting: string | null;
      timings: NetTimings;
      cert: NetCertSeen | null;
    };

export type NetRequestInput = {
  host: string;
  port: number;
  /** A certificate monitor's handshake; a TCP monitor only connects. */
  tls: boolean;
  starttls: Starttls | null;
  timeoutMs?: number;
  /** Trusted CAs besides the system's, for tests. */
  ca?: string;
};

class RunError extends Error {}

const maxReplyBytes = 16 * 1024;

/** "DNS:a.example.com, DNS:*.example.com, IP Address:10.0.0.5" → its names; the CN without any. */
function namesOf(alt: string | undefined, cn: string): string[] {
  const names = (alt ?? "")
    .split(",")
    .map((part) => part.trim())
    .flatMap((part) => {
      const m = /^(DNS|IP Address):(.+)$/.exec(part);
      return m ? [m[2]!.trim().toLowerCase()] : [];
    });
  return names.length > 0 ? names : cn ? [cn.toLowerCase()] : [];
}

function certOf(socket: TLSSocket): NetCertSeen | null {
  const peer = socket.getPeerCertificate();
  if (!peer || !peer.valid_to) {
    return null;
  }
  const to = Date.parse(peer.valid_to);
  const name = (v: unknown) => (Array.isArray(v) ? String(v[0] ?? "") : typeof v === "string" ? v : "");
  const subject = name(peer.subject?.CN);
  return {
    subject,
    names: namesOf(peer.subjectaltname, subject),
    issuer: name(peer.issuer?.O) || name(peer.issuer?.CN),
    valid_to: Number.isFinite(to) ? new Date(to).toISOString() : peer.valid_to,
    untrusted: socket.authorized ? null : tlsError(socket.authorizationError),
  };
}

/** Lines the server sends, read one reply at a time. Its listener is gone before TLS takes the socket. */
function lineReader(socket: Socket) {
  let buf = "";
  let waiting: { done: (line: string) => boolean; resolve: (lines: string[]) => void; reject: (e: Error) => void } | null = null;
  let got: string[] = [];
  let failed: Error | null = null;
  const drain = () => {
    if (!waiting) {
      return;
    }
    let at: number;
    while ((at = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, at).replace(/\r$/, "");
      buf = buf.slice(at + 1);
      got.push(line);
      if (waiting.done(line)) {
        const w = waiting;
        const lines = got;
        waiting = null;
        got = [];
        w.resolve(lines);
        return;
      }
    }
    if (buf.length > maxReplyBytes) {
      waiting.reject(new RunError("the server's reply is over 16 KB"));
      waiting = null;
    }
  };
  const onData = (chunk: Buffer) => {
    buf += chunk.toString("latin1");
    drain();
  };
  const onEnd = () => {
    failed = new RunError("closed before STARTTLS");
    waiting?.reject(failed);
    waiting = null;
  };
  socket.on("data", onData);
  socket.on("end", onEnd);
  socket.on("error", onEnd);
  return {
    /** Lines up to and including the one `done` says ends the reply. */
    reply(done: (line: string) => boolean): Promise<string[]> {
      if (failed) {
        return Promise.reject(failed);
      }
      return new Promise((resolve, reject) => {
        waiting = { done, resolve, reject };
        drain();
      });
    },
    send(line: string) {
      socket.write(`${line}\r\n`);
    },
    stop() {
      socket.removeListener("data", onData);
      socket.removeListener("end", onEnd);
      socket.removeListener("error", onEnd);
      socket.pause();
    },
  };
}

function short(text: string): string {
  const t = text.trim();
  return t.length > 120 ? `${t.slice(0, 119)}…` : t;
}

/** The plaintext exchange before TLS: the greeting, then the protocol's STARTTLS. Returns the greeting. */
async function startTls(socket: Socket, proto: Starttls): Promise<string> {
  const io = lineReader(socket);
  const smtpEnd = (l: string) => /^\d{3}(?: |$)/.test(l);
  try {
    if (proto === "smtp") {
      const greeting = await io.reply(smtpEnd);
      const first = greeting[0] ?? "";
      if (!first.startsWith("220")) {
        throw new RunError(`smtp greeting is not 220: ${short(first)}`);
      }
      io.send("EHLO toposcope");
      const ehlo = await io.reply(smtpEnd);
      if (!ehlo.at(-1)!.startsWith("250")) {
        throw new RunError(`EHLO refused: ${short(ehlo.at(-1)!)}`);
      }
      io.send("STARTTLS");
      const go = (await io.reply(smtpEnd)).at(-1)!;
      if (!go.startsWith("220")) {
        throw new RunError(`STARTTLS refused: ${short(go)}`);
      }
      return short(greeting.at(-1)!);
    }
    if (proto === "imap") {
      const greeting = (await io.reply(() => true))[0]!;
      if (!/^\* (OK|PREAUTH)\b/i.test(greeting)) {
        throw new RunError(`imap greeting is not OK: ${short(greeting)}`);
      }
      io.send("a1 STARTTLS");
      const go = (await io.reply((l) => /^a1 /i.test(l))).at(-1)!;
      if (!/^a1 OK\b/i.test(go)) {
        throw new RunError(`STARTTLS refused: ${short(go)}`);
      }
      return short(greeting);
    }
    const greeting = (await io.reply(() => true))[0]!;
    if (!greeting.startsWith("+OK")) {
      throw new RunError(`pop3 greeting is not +OK: ${short(greeting)}`);
    }
    io.send("STLS");
    const go = (await io.reply(() => true))[0]!;
    if (!go.startsWith("+OK")) {
      throw new RunError(`STARTTLS refused: ${short(go)}`);
    }
    return short(greeting);
  } finally {
    io.stop();
  }
}

/** One run, start to end, in at most 10s. */
export async function runNetRequest(input: NetRequestInput): Promise<NetExchange> {
  const timeoutMs = input.timeoutMs ?? httpTimeoutMs;
  const t0 = performance.now();
  const at = () => performance.now() - t0;
  const timings: NetTimings = { dns: 0, connect: 0, starttls: null, tls: null, total: 0 };
  const host = input.host.replace(/^\[|\]$/g, "");
  let socket: Socket | TLSSocket | null = null;
  let address: string | null = null;
  let greeting: string | null = null;
  let cert: NetCertSeen | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let over = false;
  /** After the 10s are up, a step still in flight stops where it is. */
  const still = <T extends Socket | null>(s: T): T => {
    if (over) {
      s?.destroy();
      throw new RunError("timeout");
    }
    return s;
  };

  const run = async (): Promise<void> => {
    let mark = 0;
    let addrs: string[];
    try {
      addrs = await addresses(host);
    } catch (err) {
      throw new RunError(netError(err, host));
    }
    still(null);
    timings.dns = at() - mark;
    mark = at();
    let tcp: Socket | null = null;
    let lastErr: unknown = null;
    for (const a of addrs) {
      try {
        // Held from the start, so the 10s can close a connect that never answers.
        tcp = await openTcp(a, input.port, (held) => (socket = held));
        address = a;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!tcp) {
      throw new RunError(netError(lastErr, host));
    }
    // A reset after this ends the run where it is, never the process.
    tcp.on("error", () => undefined);
    socket = still(tcp);
    timings.connect = at() - mark;
    mark = at();
    if (!input.tls) {
      return;
    }
    if (input.starttls) {
      greeting = await startTls(tcp, input.starttls);
      still(tcp);
      timings.starttls = at() - mark;
      mark = at();
    }
    let secure: TLSSocket;
    try {
      // A mail server or a database port need not speak http/1.1, so nothing is offered.
      secure = await openTls(tcp, isIP(host) ? undefined : host, input.ca, null);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      throw new RunError(e?.code?.startsWith("ERR_SSL") || !e?.code ? `tls handshake failed: ${short(e?.message ?? String(err))}` : netError(err, host));
    }
    secure.on("error", () => undefined);
    socket = still(secure);
    timings.tls = at() - mark;
    cert = certOf(secure);
    if (!cert) {
      throw new RunError("no certificate");
    }
  };

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      over = true;
      reject(new RunError(`timeout after ${Number((timeoutMs / 1000).toFixed(1))}s`));
    }, timeoutMs);
  });
  try {
    await Promise.race([run(), timeout]);
    timings.total = at();
    return { ok: true, address: address!, greeting, timings, cert };
  } catch (err) {
    timings.total = at();
    return {
      ok: false,
      error: err instanceof RunError ? err.message : netError(err, host),
      address,
      greeting,
      timings,
      cert,
    };
  } finally {
    (socket as Socket | null)?.destroy();
    if (timer) {
      clearTimeout(timer);
    }
  }
}
