import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeCerts, startStands, type Certs, type Stands } from "../../scripts/http-stands";
import { runHttpRequest, type HttpExchange } from "./http-request";

let certs: Certs;
let stands: Stands;

beforeAll(() => {
  certs = makeCerts(20);
  stands = startStands(certs, { slowMs: 700 });
});

afterAll(() => {
  stands.stop();
  certs.cleanup();
});

const get = (url: string, extra: Partial<Parameters<typeof runHttpRequest>[0]> = {}) =>
  runHttpRequest({ url, method: "GET", headers: [], body: null, ...extra });

function ok(x: HttpExchange): Extract<HttpExchange, { ok: true }> {
  if (!x.ok) {
    throw new Error(`expected a response, got ${x.error}`);
  }
  return x;
}

describe("runHttpRequest", () => {
  test("a 200 says its status, version, headers, body and where its time went", async () => {
    const x = ok(await get(`${stands.http}/health`));
    expect(x.status).toBe(200);
    expect(x.status_text).toBe("OK");
    expect(x.http_version).toBe("HTTP/1.1");
    expect(x.headers.find(([k]) => k === "content-type")?.[1]).toContain("application/json");
    expect(JSON.parse(x.body)).toEqual({ db: "ok", queue: { depth: 3 }, version: "0.9.3" });
    expect(x.body_bytes).toBe(x.body.length);
    expect(x.cert).toBeNull();
    expect(x.timings.tls).toBeNull();
    for (const k of ["dns", "connect", "wait", "body", "total"] as const) {
      expect(x.timings[k]).toBeGreaterThanOrEqual(0);
    }
    expect(x.timings.total).toBeGreaterThanOrEqual(x.timings.wait);
  });

  test("a 503 is a response, not an error", async () => {
    const x = ok(await get(`${stands.http}/down`));
    expect(x.status).toBe(503);
    expect(x.body).toBe("upstream down");
  });

  test("a chunked body and a gzip body are read whole", async () => {
    expect(JSON.parse(ok(await get(`${stands.http}/chunked`)).body)).toEqual({ db: "ok" });
    expect(JSON.parse(ok(await get(`${stands.http}/gzip`)).body).db).toBe("ok");
  });

  test("a redirect is not followed", async () => {
    const x = ok(await get(`${stands.http}/redirect`));
    expect(x.status).toBe(302);
    expect(x.headers.find(([k]) => k === "location")?.[1]).toBe("https://example.com/elsewhere");
    expect(stands.hits.get("/elsewhere")).toBeUndefined();
  });

  test("HEAD reads no body, and POST sends its body and headers", async () => {
    const head = ok(await runHttpRequest({ url: `${stands.http}/health`, method: "HEAD", headers: [], body: null }));
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    const post = ok(
      await runHttpRequest({
        url: `${stands.http}/echo`,
        method: "POST",
        headers: [["Authorization", "Bearer s3cret"]],
        body: '{"ping":1}',
      }),
    );
    expect(JSON.parse(post.body)).toEqual({ method: "POST", body: '{"ping":1}' });
    expect(stands.last.get("/echo")?.headers.authorization).toBe("Bearer s3cret");
    expect(stands.last.get("/echo")?.headers["content-type"]).toBe("application/json");
  });

  test("nothing listening is connect ECONNREFUSED", async () => {
    const free = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = free.port;
    free.stop(true);
    const x = await get(`http://127.0.0.1:${port}/`);
    expect(x.ok).toBe(false);
    expect(!x.ok && x.error).toBe("connect ECONNREFUSED");
  });

  test("a slow answer past the timeout is a timeout", async () => {
    const x = await get(`${stands.http}/slow`, { timeoutMs: 300 });
    expect(x.ok).toBe(false);
    expect(!x.ok && x.error).toBe("timeout after 0s");
    const y = await get(`${stands.http}/slow`, { timeoutMs: 2_000 });
    expect(y.ok).toBe(true);
  });

  test("over TLS it reads the certificate and times the handshake", async () => {
    const x = ok(await get(`${stands.https}/health`, { ca: certs.ca }));
    expect(x.status).toBe(200);
    expect(x.cert?.subject).toBe("localhost");
    const left = Date.parse(x.cert!.valid_to) - Date.now();
    expect(left).toBeGreaterThan(19 * 86_400_000);
    expect(left).toBeLessThan(21 * 86_400_000);
    expect(x.timings.tls).toBeGreaterThan(0);
  });

  test("a certificate it does not trust ends the run before any header is sent", async () => {
    const before = stands.hits.get("/health") ?? 0;
    const x = await get(`${stands.https}/health`, { headers: [["Authorization", "Bearer s3cret"]] });
    expect(x.ok).toBe(false);
    expect(!x.ok && x.error).toBe("certificate is not trusted");
    // It still says what answered.
    expect(x.cert?.subject).toBe("localhost");
    expect(stands.hits.get("/health") ?? 0).toBe(before);
  });

  test("a certificate for another host is refused", async () => {
    const other = makeCerts(90, ["other.test"]);
    const stand = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { cert: other.cert, key: other.key },
      fetch: () => new Response("ok"),
    });
    try {
      const byName = await get(`https://localhost:${stand.port}/`, { ca: other.ca });
      expect(!byName.ok && byName.error).toBe("certificate is not for this host");
      const byAddress = await get(`https://127.0.0.1:${stand.port}/`, { ca: other.ca });
      expect(!byAddress.ok && byAddress.error).toBe("certificate is not for this host");
    } finally {
      stand.stop(true);
      other.cleanup();
    }
  });
});
