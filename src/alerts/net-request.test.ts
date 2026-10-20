import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeCerts, type Certs } from "../../scripts/http-stands";
import { startNetStands, type NetStands } from "../../scripts/net-stands";
import { parseNetTarget, type Starttls } from "../shared/net-check";
import { runNetRequest, type NetExchange } from "./net-request";

let certs: Certs;
let stands: NetStands;

beforeAll(async () => {
  certs = makeCerts(20);
  stands = await startNetStands(certs);
});

afterAll(() => {
  stands.stop();
  certs.cleanup();
});

function at(target: string) {
  const t = parseNetTarget(target);
  if ("error" in t) {
    throw new Error(t.error);
  }
  return t;
}

const tcp = (target: string, extra: { timeoutMs?: number } = {}) =>
  runNetRequest({ ...at(target), tls: false, starttls: null, ...extra });
const tls = (target: string, starttls: Starttls | null = null, extra: { ca?: string; timeoutMs?: number } = { ca: certs.ca }) =>
  runNetRequest({ ...at(target), tls: true, starttls, ...extra });

function ok(x: NetExchange): Extract<NetExchange, { ok: true }> {
  if (!x.ok) {
    throw new Error(`expected it to connect, got ${x.error}`);
  }
  return x;
}

describe("runNetRequest", () => {
  test("a port that takes the connection says where its time went", async () => {
    const x = ok(await tcp(stands.open));
    expect(x.address).toBe("127.0.0.1");
    expect(x.cert).toBeNull();
    expect(x.timings.tls).toBeNull();
    expect(x.timings.starttls).toBeNull();
    expect(x.timings.total).toBeGreaterThanOrEqual(x.timings.connect);
  });

  test("a closed port is refused", async () => {
    const x = await tcp(stands.closed);
    expect(x).toMatchObject({ ok: false, error: "connect ECONNREFUSED", address: null });
  });

  test("TLS from the first byte reads the certificate: its name, its names, when it ends", async () => {
    const x = ok(await tls(stands.tls));
    expect(x.cert).toMatchObject({ subject: "localhost", names: ["localhost", "127.0.0.1"], issuer: "Toposcope test CA", untrusted: null });
    const left = Date.parse(x.cert!.valid_to) - Date.now();
    expect(Math.round(left / (24 * 60 * 60_000))).toBe(20);
    expect(x.timings.tls).toBeGreaterThan(0);
    expect(x.protocol).toMatch(/^TLS 1\.[23]$/);
  });

  test("a certificate this node does not trust is still read, and says why", async () => {
    const x = ok(await tls(stands.tls, null, {}));
    expect(x.cert?.untrusted).toBe("certificate is not trusted");
  });

  test.each(["smtp", "imap", "pop3"] as const)("STARTTLS on %s reads its certificate", async (proto) => {
    const x = ok(await tls(stands[proto], proto));
    expect(x.cert).toMatchObject({ subject: "localhost", untrusted: null });
    expect(x.greeting).toMatch(/stand-in/);
    expect(x.timings.starttls).toBeGreaterThan(0);
  });

  test("a mail server without STARTTLS says what it answered", async () => {
    const x = await tls(stands.smtpNoTls, "smtp");
    expect(x).toMatchObject({ ok: false, error: "STARTTLS refused: 502 5.5.1 STARTTLS not here", address: "127.0.0.1", cert: null });
  });

  test("STARTTLS on a port that waits for TLS gives up at the timeout", async () => {
    const x = await tls(stands.tls, "smtp", { ca: certs.ca, timeoutMs: 400 });
    expect(x).toMatchObject({ ok: false, error: "timeout after 0.4s" });
  });
});
