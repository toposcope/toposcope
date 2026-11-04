// Auth check cost from Bun, the real caller: today's in-process bun:sqlite
// read against a call over the Unix socket to the Go control service.
// Prints one JSON line; times are microseconds.
import { Database } from "bun:sqlite";

const sock = "/run/ctl/ctl.sock";
const sid = Bun.argv[2] ?? "m-0000042";

function pct(xs: number[]) {
  xs.sort((a, b) => a - b);
  const p = (q: number) => Math.round(xs[Math.min(xs.length - 1, Math.floor(q * xs.length))] * 10) / 10;
  return { n: xs.length, p50_us: p(0.5), p95_us: p(0.95), p99_us: p(0.99), max_us: p(1) };
}

async function time(n: number, fn: () => unknown | Promise<unknown>) {
  for (let i = 0; i < Math.min(500, n); i++) await fn();
  const xs: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = Bun.nanoseconds();
    await fn();
    xs.push((Bun.nanoseconds() - t) / 1000);
  }
  return pct(xs);
}

// Today: a SQLite file in the Bun process, 50k sessions, WAL, prepared query.
const db = new Database("/tmp/today.sqlite", { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("DROP TABLE IF EXISTS sessions");
db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER)");
const ins = db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, NULL)");
db.transaction(() => {
  const now = Date.now();
  for (let i = 0; i < 50000; i++) ins.run(`m-${String(i).padStart(7, "0")}`, i % 500, now, now + 30 * 86400_000);
})();
const check = db.prepare("SELECT 1 FROM sessions WHERE id = ? AND revoked_at IS NULL AND expires_at > ?");
const inProcess = await time(20000, () => check.get(sid, Date.now()));

const get = (path: string) => fetch(`http://localhost${path}`, { unix: sock }).then((r) => r.text());
const ping = await time(5000, () => get("/ping"));
const auth = await time(5000, () => get(`/auth?s=${sid}`));
if ((await get(`/auth?s=${sid}`)) !== "true") throw new Error("auth over the socket did not accept the seeded session");

// 32 requests in flight for 3 s: what a busy Bun process would see.
async function load(path: string, inflight: number, ms: number) {
  const xs: number[] = [];
  const end = performance.now() + ms;
  await Promise.all(
    Array.from({ length: inflight }, async () => {
      while (performance.now() < end) {
        const t = Bun.nanoseconds();
        await get(path);
        xs.push((Bun.nanoseconds() - t) / 1000);
      }
    }),
  );
  return { ...pct(xs), per_s: Math.round(xs.length / (ms / 1000)) };
}
const authLoad = await load(`/auth?s=${sid}`, 32, 3000);

console.log(JSON.stringify({ bun: Bun.version, in_process_bun_sqlite: inProcess, socket_ping: ping, socket_auth: auth, socket_auth_32_inflight: authLoad }));
