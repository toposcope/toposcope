import {
  compare,
  decideLines,
  judgeCertLeft,
  type ConditionLine,
  type LineResult,
  type Verdict,
} from "./http-check";

/**
 * TCP and certificate monitors (#180): where they connect, and what their lines make of a run.
 * A TCP monitor connects to host:port; a certificate monitor goes on to a TLS handshake there,
 * from the first byte or after STARTTLS on SMTP, IMAP or POP3. Shared by the server, which
 * judges each run, and the editor, which judges the last run as lines are picked.
 */

export const netSources = ["tcp", "cert"] as const;
export type NetSource = (typeof netSources)[number];

export function isNetSource(value: unknown): value is NetSource {
  return value === "tcp" || value === "cert";
}

/** How a certificate monitor reaches TLS when not from the first byte: a mail protocol's STARTTLS. */
export const starttlsIds = ["smtp", "imap", "pop3"] as const;
export type Starttls = (typeof starttlsIds)[number];

export function parseStarttls(value: unknown): Starttls | null | undefined {
  if (value === null || value === undefined || value === "" || value === "none") {
    return null;
  }
  return typeof value === "string" && (starttlsIds as readonly string[]).includes(value.toLowerCase())
    ? (value.toLowerCase() as Starttls)
    : undefined;
}

export const maxNetTarget = 300;

export type NetTarget = { host: string; port: number };

const hostRe = /^[A-Za-z0-9_]([A-Za-z0-9_-]*[A-Za-z0-9_])?(\.[A-Za-z0-9_]([A-Za-z0-9_-]*[A-Za-z0-9_])?)*\.?$/;

/** "db.internal:5432", "10.0.0.5:6379", "[::1]:993": a host and a port, or why it is not one. */
export function parseNetTarget(raw: string): NetTarget | { error: string } {
  const text = raw.trim();
  if (!text) {
    return { error: "target is required: host:port" };
  }
  if (text.length > maxNetTarget) {
    return { error: `target is longer than ${maxNetTarget} characters` };
  }
  if (text.includes("://") || text.includes("/")) {
    return { error: "target is host:port, without a scheme or a path" };
  }
  const v6 = /^\[([0-9A-Fa-f:.]+)\]:(\d+)$/.exec(text);
  const m = v6 ?? /^([^:\s]+):(\d+)$/.exec(text);
  if (!m) {
    return { error: "target is host:port: db.internal:5432, or [::1]:993" };
  }
  const host = m[1]!;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return { error: "the port must be 1 to 65535" };
  }
  if (!v6 && !hostRe.test(host)) {
    return { error: `${host} is not a host name or an address` };
  }
  return { host: host.toLowerCase(), port };
}

/** A target as a line, a row and the editor write it: `host:port`, an IPv6 address in brackets. */
export function formatNetTarget(t: NetTarget): string {
  return t.host.includes(":") ? `[${t.host}]:${t.port}` : `${t.host}:${t.port}`;
}

function isAddress(host: string): boolean {
  return /^[\d.]+$/.test(host) || host.includes(":");
}

/** The certificate a handshake was answered with. */
export type NetCertSeen = {
  /** The name it was issued to (its CN), or "" without one. */
  subject: string;
  /** What it is for: its DNS and IP subject alternative names, or its CN when it has none. */
  names: string[];
  issuer: string;
  /** ISO. */
  valid_to: string;
  /** Why a client would not trust it (`certificate has expired`, `certificate is self-signed`); null when it would. */
  untrusted: string | null;
};

/** What a run saw: it connected, in this long, and (a certificate monitor) the certificate. */
export type NetSeen = { durationMs: number; cert: NetCertSeen | null };

/**
 * Whether a certificate is for `name` as a TLS client checks it: one of its names, the same up
 * to case, a `*.` standing for exactly the leftmost label.
 */
export function certCovers(names: readonly string[], name: string): boolean {
  const want = name.toLowerCase().replace(/\.$/, "");
  return names.some((raw) => {
    const n = raw.toLowerCase().replace(/\.$/, "");
    if (n === want) {
      return true;
    }
    if (!n.startsWith("*.") || isAddress(want)) {
      return false;
    }
    const at = want.indexOf(".");
    return at > 0 && want.slice(at + 1) === n.slice(2);
  });
}

/** "*.agental.dev", "a.example.com +2": a certificate's names, short. */
export function certNamesShort(names: readonly string[]): string {
  if (names.length === 0) {
    return "no name";
  }
  return names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0]!;
}

function judgeNetLine(line: ConditionLine, seen: NetSeen, nowMs: number): LineResult {
  const c = line.cond;
  switch (c.what) {
    case "connected":
      return { pass: true, got: "yes", why: null };
    case "time": {
      const ms = Math.round(seen.durationMs);
      const pass = compare(ms, c.op, c.ms);
      const word = c.op === "<" || c.op === "<=" ? "over" : "under";
      return { pass, got: `${ms}ms`, why: pass ? null : `${ms}ms is ${word} ${c.ms}ms` };
    }
    case "cert":
      return seen.cert
        ? judgeCertLeft(c, seen.cert.valid_to, nowMs)
        : { pass: false, got: "no certificate", why: "no certificate" };
    case "cert-name": {
      if (!seen.cert) {
        return { pass: false, got: "no certificate", why: "no certificate" };
      }
      const pass = certCovers(seen.cert.names, c.name);
      const got = seen.cert.subject || certNamesShort(seen.cert.names);
      return { pass, got, why: pass ? null : `certificate is for ${certNamesShort(seen.cert.names)}, not ${c.name}` };
    }
    default:
      // The parser keeps an HTTP(S) monitor's lines out.
      return { pass: null, got: "—", why: null };
  }
}

/**
 * A run's result. Not connecting, or a handshake that did not finish, is a fail with its error,
 * whatever the lines say (`connected` reads ✗ with it). A TCP monitor that connected passes its
 * lines or, with none, passes. A certificate monitor fails on a certificate a client would not
 * trust, or one not for its host unless a `cert name ==` line names the one it must be for; then
 * its lines decide, and with none it passes.
 */
export function judgeNetRun(
  source: NetSource,
  lines: readonly ConditionLine[],
  run: { seen: NetSeen; host: string } | { error: string },
  nowMs: number,
): Verdict {
  if ("error" in run) {
    const connected = lines.find((l) => l.cond.what === "connected");
    return {
      result: "fail",
      lines: lines.map((l) =>
        l.cond.what === "connected" ? { pass: false, got: "no", why: run.error } : { pass: null, got: "—", why: null },
      ),
      line: connected?.text ?? null,
      why: run.error,
    };
  }
  const results = lines.map((l) => judgeNetLine(l, run.seen, nowMs));
  if (source === "cert") {
    const cert = run.seen.cert;
    if (!cert) {
      return { result: "fail", lines: results, line: null, why: "no certificate" };
    }
    if (cert.untrusted) {
      return { result: "fail", lines: results, line: null, why: cert.untrusted };
    }
    if (!lines.some((l) => l.cond.what === "cert-name") && !certCovers(cert.names, run.host)) {
      return { result: "fail", lines: results, line: null, why: `certificate is for ${certNamesShort(cert.names)}, not ${run.host}` };
    }
  }
  return decideLines(lines, results);
}
