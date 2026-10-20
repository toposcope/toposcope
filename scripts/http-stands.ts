import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

/**
 * Stand-ins for HTTP(S) monitors (#178), for `bun test` and `bun run e2e`: a JSON health
 * endpoint, a 503, one that flips between them on request, a slow one, a body that is not
 * JSON, a redirect off its host, and the same over TLS with a certificate a CA of its own
 * signed, a given number of days from expiry.
 */

export type Certs = { dir: string; ca: string; caPath: string; cert: string; key: string; cleanup: () => void };

/** A CA, and a certificate for `names` (localhost and 127.0.0.1) that it signed, valid for `days` more days. */
export function makeCerts(days: number, names: string[] = ["localhost", "127.0.0.1"], into?: string): Certs {
  const dir = into ?? mkdtempSync(join(tmpdir(), "toposcope-certs-"));
  mkdirSync(dir, { recursive: true });
  const run = (args: string[]) => {
    const out = Bun.spawnSync(["openssl", ...args], { cwd: dir, stderr: "pipe" });
    if (out.exitCode !== 0) {
      throw new Error(`openssl ${args[0]} failed: ${out.stderr.toString()}`);
    }
  };
  run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "3650", "-subj", "/CN=Toposcope test CA"]);
  run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", `/CN=${names[0]}`]);
  const alt = names.map((n) => (/^[\d.]+$/.test(n) ? `IP:${n}` : `DNS:${n}`)).join(",");
  writeFileSync(join(dir, "ext.cnf"), `subjectAltName=${alt}\n`);
  run(["x509", "-req", "-in", "leaf.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.crt", "-days", String(days), "-extfile", "ext.cnf"]);
  return {
    dir,
    ca: readFileSync(join(dir, "ca.crt"), "utf8"),
    caPath: join(dir, "ca.crt"),
    cert: readFileSync(join(dir, "leaf.crt"), "utf8"),
    key: readFileSync(join(dir, "leaf.key"), "utf8"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Certificates `makeCerts` wrote to `dir` before, as `bun run scripts/http-stands.ts certs <dir>` leaves them. */
export function readCerts(dir: string): Certs {
  return {
    dir,
    ca: readFileSync(join(dir, "ca.crt"), "utf8"),
    caPath: join(dir, "ca.crt"),
    cert: readFileSync(join(dir, "leaf.crt"), "utf8"),
    key: readFileSync(join(dir, "leaf.key"), "utf8"),
    cleanup: () => undefined,
  };
}

export const healthBody = { db: "ok", queue: { depth: 3 }, version: "0.9.3" };

export type Stands = {
  http: string;
  https: string;
  /** What `/flip` answers next: 200 or 503. */
  flip: (status: 200 | 503) => void;
  /** Requests each path has had. */
  hits: Map<string, number>;
  /** The last request each path had: method, headers, body. */
  last: Map<string, { method: string; headers: Record<string, string>; body: string }>;
  stop: () => void;
};

function answer(req: Request, state: { flip: number }, slowMs: number): Response | Promise<Response> {
  const path = new URL(req.url).pathname;
  switch (path) {
    case "/health":
      return Response.json(healthBody);
    case "/db-down":
      return Response.json({ db: "down", queue: { depth: 120 } });
    case "/down":
      return new Response("upstream down", { status: 503, statusText: "Service Unavailable" });
    case "/flip":
      return state.flip === 200 ? Response.json({ db: "ok" }) : new Response("down", { status: 503 });
    case "/slow":
      return Bun.sleep(slowMs).then(() => Response.json(healthBody));
    case "/bad-json":
      return new Response('{"db": "ok",', { headers: { "content-type": "application/json" } });
    case "/redirect":
      return new Response(null, { status: 302, headers: { location: "https://example.com/elsewhere" } });
    case "/chunked":
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"db":'));
            c.enqueue(new TextEncoder().encode('"ok"}'));
            c.close();
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    case "/gzip":
      return new Response(gzipSync(JSON.stringify(healthBody)), {
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
      });
    case "/echo":
      return req.text().then((body) => Response.json({ method: req.method, body }));
    default:
      return new Response("not here", { status: 404 });
  }
}

/** Both stands on spare ports of 127.0.0.1. `slowMs` is how long `/slow` takes. */
export function startStands(certs: Certs, opts: { slowMs?: number; port?: number; tlsPort?: number } = {}): Stands {
  const state = { flip: 503 };
  const hits = new Map<string, number>();
  const last = new Map<string, { method: string; headers: Record<string, string>; body: string }>();
  const slowMs = opts.slowMs ?? 1_500;
  const fetch = async (req: Request) => {
    const path = new URL(req.url).pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    const body = req.method === "POST" ? await req.clone().text() : "";
    last.set(path, { method: req.method, headers: Object.fromEntries(req.headers), body });
    return answer(req, state, slowMs);
  };
  const plain = Bun.serve({ hostname: "127.0.0.1", port: opts.port ?? 0, idleTimeout: 30, fetch });
  const secure = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.tlsPort ?? 0,
    idleTimeout: 30,
    tls: { cert: certs.cert, key: certs.key },
    fetch,
  });
  return {
    http: `http://127.0.0.1:${plain.port}`,
    https: `https://localhost:${secure.port}`,
    flip: (status) => {
      state.flip = status;
    },
    hits,
    last,
    stop: () => {
      plain.stop(true);
      secure.stop(true);
    },
  };
}

// `bun run scripts/http-stands.ts certs <dir> [days]`: a CA and a localhost certificate it signed,
// `days` (20) from expiry, so an app started with NODE_EXTRA_CA_CERTS=<dir>/ca.crt trusts the
// TLS stand that `bun run e2e` starts with TOPOSCOPE_E2E_CERTS=<dir>.
if (import.meta.main) {
  const [cmd, dir, days] = Bun.argv.slice(2);
  if (cmd !== "certs" || !dir) {
    console.error("usage: bun run scripts/http-stands.ts certs <dir> [days]");
    process.exit(2);
  }
  if (existsSync(join(dir, "ca.crt"))) {
    console.log(join(dir, "ca.crt"));
  } else {
    console.log(makeCerts(Number(days ?? 20), undefined, dir).caPath);
  }
}
