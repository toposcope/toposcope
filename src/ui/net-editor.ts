import { parseNetTarget, type NetSource, type Starttls } from "../shared/net-check";
import { barOf, type TimingBar } from "./http-editor";

/**
 * The TCP · certificate editor (#180), as 18r draws the HTTP(S) one: what it connects to, its
 * lines picked from the last run and stored as text.
 */

/** The editor's select, where 18r has the method: TCP, or a certificate over TLS or STARTTLS. */
export const netModes = ["tcp", "tls", "smtp", "imap", "pop3"] as const;
export type NetMode = (typeof netModes)[number];

export const netModeLabel: Record<NetMode, string> = { tcp: "TCP", tls: "TLS", smtp: "SMTP", imap: "IMAP", pop3: "POP3" };

export function netModeOf(source: NetSource, starttls: Starttls | null): NetMode {
  return source === "tcp" ? "tcp" : (starttls ?? "tls");
}

export function netSourceOf(mode: NetMode): { source: NetSource; starttls: Starttls | null } {
  return mode === "tcp" ? { source: "tcp", starttls: null } : { source: "cert", starttls: mode === "tls" ? null : mode };
}

/** A port it is usually on, for the placeholder. */
export const netModeExample: Record<NetMode, string> = {
  tcp: "db.internal:5432",
  tls: "imap.example.com:993",
  smtp: "smtp.example.com:587",
  imap: "imap.example.com:143",
  pop3: "pop.example.com:110",
};

/** "db:5432", "10.0.0.5:6379", "smtp.agental.dev certificate": a name to start from. */
export function nameFromTarget(raw: string, source: NetSource): string {
  const t = parseNetTarget(raw);
  if ("error" in t) {
    return "";
  }
  if (source === "cert") {
    return `${t.host} certificate`.slice(0, 80);
  }
  // An address or a bare name is kept whole.
  const bare = /^[\d.]+$/.test(t.host) || t.host.includes(":") || !t.host.includes(".");
  return `${bare ? t.host : t.host.split(".")[0]!}:${t.port}`.slice(0, 80);
}

export type NetTimings = { dns: number; connect: number; starttls: number | null; tls: number | null; total: number };

/** The run's parts on 18r's bar: dns, connect, then STARTTLS and the handshake on a certificate monitor. */
export function netTimingBar(t: NetTimings, limitMs: number | null): TimingBar {
  return barOf(
    [
      ["dns", t.dns],
      ["connect", t.connect],
      ["starttls", t.starttls ?? 0],
      ["tls", t.tls ?? 0],
    ],
    t.total,
    limitMs,
    "connect",
  );
}

/** "dns 4 · connect 18 · starttls 6 · tls 41". */
export function netTimingWords(t: NetTimings): string {
  const r = (n: number) => String(Math.round(n));
  return [
    `dns ${r(t.dns)}`,
    `connect ${r(t.connect)}`,
    ...(t.starttls !== null ? [`starttls ${r(t.starttls)}`] : []),
    ...(t.tls !== null ? [`tls ${r(t.tls)}`] : []),
  ].join(" · ");
}

/** The cert name a run offers: what the certificate was issued to, else the host it was asked for. */
export function offeredCertName(cert: { subject: string; names: string[] }, target: string): string | null {
  const name = cert.subject || cert.names[0] || "";
  if (name && !/\s/.test(name)) {
    return `cert name == ${name.toLowerCase()}`;
  }
  const t = parseNetTarget(target);
  return "error" in t ? null : `cert name == ${t.host}`;
}
