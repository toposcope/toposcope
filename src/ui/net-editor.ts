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

/** What each one does, beside it in the menu (18x). */
export const netModeAbout: Record<NetMode, string> = {
  tcp: "connects",
  tls: "certificate",
  smtp: "certificate · STARTTLS",
  imap: "certificate · STARTTLS",
  pop3: "certificate · STARTTLS",
};

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

/** db.internal from db.internal:5432, ::1 from [::1]:993: the host it checks (#335). */
export function hostFromTarget(raw: string): string {
  const t = parseNetTarget(raw);
  return "error" in t ? "" : t.host;
}

/** "db:5432", "10.0.0.5:6379", "smtp certificate": a name to start from (18x). */
export function nameFromTarget(raw: string, source: NetSource): string {
  const t = parseNetTarget(raw);
  if ("error" in t) {
    return "";
  }
  // An address or a bare name is kept whole.
  const bare = /^[\d.]+$/.test(t.host) || t.host.includes(":") || !t.host.includes(".");
  const host = bare ? t.host : t.host.split(".")[0]!;
  return (source === "cert" ? `${host} certificate` : `${host}:${t.port}`).slice(0, 80);
}

export type NetTimings = { dns: number; connect: number; starttls: number | null; tls: number | null; total: number };

/** TLS's share: the handshake, and the STARTTLS exchange before it (18x draws them as one). */
function tlsMs(t: NetTimings): number | null {
  return t.tls === null && t.starttls === null ? null : (t.tls ?? 0) + (t.starttls ?? 0);
}

/** The run's parts on 18r's bar: dns, connect, and on a certificate monitor tls (18x). */
export function netTimingBar(t: NetTimings, limitMs: number | null): TimingBar {
  return barOf(
    [
      ["dns", t.dns],
      ["connect", t.connect],
      ["tls", tlsMs(t) ?? 0],
    ],
    t.total,
    limitMs,
    "connect",
  );
}

/** "dns 3 · connect 22 · tls 33" (18x). */
export function netTimingWords(t: NetTimings): string {
  const r = (n: number) => String(Math.round(n));
  const tls = tlsMs(t);
  return [`dns ${r(t.dns)}`, `connect ${r(t.connect)}`, ...(tls !== null ? [`tls ${r(tls)}`] : [])].join(" · ");
}

/** "TLS 1.3 via STARTTLS", "TLS 1.3": how a certificate monitor got to its certificate. */
export function tlsWords(protocol: string | null, starttls: Starttls | null): string {
  return `${protocol ?? "TLS"}${starttls ? " via STARTTLS" : ""}`;
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
