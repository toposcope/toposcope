import type { LogLevel } from "./log-event";

export type FakeEventOpts = {
  i: number;
  n: number;
  now: number;
  windowMs: number;
  marker?: string;
};

type Weighted<T> = readonly { v: T; w: number }[];

const services: Weighted<string> = [
  { v: "api", w: 48 },
  { v: "web", w: 24 },
  { v: "worker", w: 18 },
  { v: "billing", w: 10 },
];

const quietLevels: Weighted<LogLevel> = [
  { v: "info", w: 68 },
  { v: "debug", w: 18 },
  { v: "warn", w: 10 },
  { v: "error", w: 3 },
  { v: "fatal", w: 1 },
];

const burstLevels: Weighted<LogLevel> = [
  { v: "error", w: 42 },
  { v: "warn", w: 28 },
  { v: "info", w: 18 },
  { v: "fatal", w: 8 },
  { v: "debug", w: 4 },
];

const paths: Weighted<string> = [
  { v: "/v1/items", w: 36 },
  { v: "/v1/checkout", w: 18 },
  { v: "/api/search", w: 14 },
  { v: "/v1/logs", w: 10 },
  { v: "/health", w: 10 },
  { v: "/v1/users", w: 8 },
  { v: "/internal/jobs", w: 4 },
];

const okStatus: Weighted<number> = [
  { v: 200, w: 82 },
  { v: 201, w: 10 },
  { v: 204, w: 8 },
];

const warnStatus: Weighted<number> = [
  { v: 429, w: 40 },
  { v: 400, w: 25 },
  { v: 401, w: 20 },
  { v: 404, w: 15 },
];

const errorStatus: Weighted<number> = [
  { v: 500, w: 45 },
  { v: 502, w: 30 },
  { v: 503, w: 25 },
];

const hostsByService: Record<string, Weighted<string>> = {
  api: [
    { v: "api-1", w: 55 },
    { v: "api-2", w: 30 },
    { v: "api-3", w: 15 },
  ],
  web: [
    { v: "web-1", w: 70 },
    { v: "web-2", w: 30 },
  ],
  worker: [
    { v: "worker-1", w: 80 },
    { v: "worker-2", w: 20 },
  ],
  billing: [{ v: "billing-1", w: 100 }],
};

const messages: Record<LogLevel, readonly string[]> = {
  debug: ["cache miss", "retrying job", "health check ok"],
  info: ["request completed", "connected", "user login", "health check ok"],
  warn: ["rate limited", "timeout", "cache miss"],
  error: ["timeout", "upstream 502", "panic recovered"],
  fatal: ["panic recovered", "upstream 502"],
};

/** Mix `i` into a 32-bit value. Same i always yields the same fake event. */
export function mix32(i: number, salt: number): number {
  let x = Math.imul(i ^ salt, 0x9e3779b9) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x21f0aaad) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  return x >>> 0;
}

function pickWeighted<T>(u: number, table: Weighted<T>): T {
  let total = 0;
  for (const row of table) {
    total += row.w;
  }
  let r = u % total;
  for (const row of table) {
    if (r < row.w) {
      return row.v;
    }
    r -= row.w;
  }
  const last = table[table.length - 1];
  if (!last) {
    throw new Error("empty weighted table");
  }
  return last.v;
}

function pickAt<T>(u: number, items: readonly T[]): T {
  const item = items[u % items.length];
  if (item === undefined) {
    throw new Error("empty pick");
  }
  return item;
}

function burstMinute(tsMs: number): boolean {
  const minute = Math.floor(tsMs / 60_000);
  return mix32(minute, 91) % 11 === 0;
}

function statusFor(level: LogLevel, u: number): number {
  switch (level) {
    case "error":
    case "fatal":
      return pickWeighted(u, errorStatus);
    case "warn":
      return pickWeighted(u, warnStatus);
    default:
      return pickWeighted(u, okStatus);
  }
}

function durationMs(level: LogLevel, u: number): number {
  const base = (u % 180) + 8;
  switch (level) {
    case "error":
    case "fatal":
      return base + 400 + (u % 900);
    case "warn":
      return base + 120;
    default:
      return base;
  }
}

/** Zipf-ish user ids: a few heavy hitters, long tail. */
function userId(u: number): string {
  const rank = Math.min(79, Math.floor((u % 10_000) / 125));
  return `u-${rank}`;
}

/**
 * Region-weighted public /16s (ISP space, not TEST-NET). Weights sum to 100
 * (NA 36 / EU 24 / APAC 22 / LatAm 8 / Africa 5 / ME 5). Host octets Zipf off
 * a second mix over the /16 so cardinality is high and Top-N still has heavies.
 */
export const fakeClientNets: ReadonlyArray<{
  a: number;
  b: number;
  w: number;
}> = [
  { a: 73, b: 162, w: 6 },
  { a: 174, b: 62, w: 5 },
  { a: 12, b: 216, w: 4 },
  { a: 24, b: 4, w: 4 },
  { a: 98, b: 234, w: 3 },
  { a: 76, b: 97, w: 3 },
  { a: 108, b: 18, w: 3 },
  { a: 67, b: 180, w: 2 },
  { a: 50, b: 184, w: 2 },
  { a: 99, b: 224, w: 2 },
  { a: 142, b: 179, w: 2 },
  { a: 81, b: 136, w: 3 },
  { a: 82, b: 37, w: 2 },
  { a: 79, b: 192, w: 3 },
  { a: 91, b: 65, w: 1 },
  { a: 90, b: 63, w: 3 },
  { a: 77, b: 163, w: 2 },
  { a: 87, b: 12, w: 2 },
  { a: 80, b: 58, w: 2 },
  { a: 78, b: 69, w: 2 },
  { a: 83, b: 11, w: 2 },
  { a: 95, b: 53, w: 2 },
  { a: 126, b: 2, w: 3 },
  { a: 118, b: 21, w: 1 },
  { a: 111, b: 13, w: 2 },
  { a: 220, b: 181, w: 2 },
  { a: 114, b: 80, w: 1 },
  { a: 211, b: 192, w: 2 },
  { a: 168, b: 95, w: 1 },
  { a: 49, b: 205, w: 2 },
  { a: 117, b: 192, w: 2 },
  { a: 165, b: 21, w: 1 },
  { a: 1, b: 128, w: 2 },
  { a: 139, b: 130, w: 1 },
  { a: 180, b: 252, w: 2 },
  { a: 177, b: 55, w: 2 },
  { a: 189, b: 84, w: 2 },
  { a: 187, b: 190, w: 2 },
  { a: 181, b: 15, w: 2 },
  { a: 41, b: 133, w: 2 },
  { a: 41, b: 184, w: 1 },
  { a: 41, b: 90, w: 1 },
  { a: 156, b: 160, w: 1 },
  { a: 31, b: 154, w: 1 },
  { a: 94, b: 200, w: 2 },
  { a: 188, b: 48, w: 2 },
];

const clientNets: Weighted<{ a: number; b: number }> = fakeClientNets.map(
  (net) => ({ v: { a: net.a, b: net.b }, w: net.w }),
);

function clientHostOctets(hostU: number): { c: number; d: number } {
  if (hostU % 100 < 40) {
    const x = hostU % 1000;
    const rank = Math.min(63, Math.floor((x * x) / 15_625));
    return { c: 1 + (rank >> 3), d: 1 + (rank & 7) * 17 };
  }
  const c = (hostU >>> 8) & 255;
  let d = hostU & 255;
  if (d === 0) {
    d = 1;
  } else if (d === 255) {
    d = 254;
  }
  return { c, d };
}

/** Must match `clientIpSql` in `scripts/load-ch-generate.ts`. */
function clientIp(netU: number, hostU: number): string {
  const net = pickWeighted(netU, clientNets);
  const host = clientHostOctets(hostU);
  return `${net.a}.${net.b}.${host.c}.${host.d}`;
}

export function fakeLogEvent(opts: FakeEventOpts): {
  ts: string;
  service: string;
  host: string;
  level: LogLevel;
  message: string;
  attrs: Record<string, string | number>;
} {
  const tsMs = opts.now - (opts.i / Math.max(1, opts.n)) * opts.windowMs;
  const service = pickWeighted(mix32(opts.i, 1), services);
  const level = pickWeighted(
    mix32(opts.i, 2),
    burstMinute(tsMs) ? burstLevels : quietLevels,
  );
  const hosts = hostsByService[service] ?? [{ v: `${service}-1`, w: 100 }];
  const path = pickWeighted(mix32(opts.i, 4), paths);
  const attrs: Record<string, string | number> = {
    path,
    status: statusFor(level, mix32(opts.i, 5)),
    duration_ms: durationMs(level, mix32(opts.i, 6)),
    request_id: `req-${mix32(opts.i, 7).toString(16)}`,
    client_ip: clientIp(mix32(opts.i, 10), mix32(opts.i, 12)),
  };
  if (mix32(opts.i, 8) % 5 < 3) {
    attrs.user_id = userId(mix32(opts.i, 9));
  }
  const body = pickAt(mix32(opts.i, 3), messages[level]);
  const message = opts.marker ? `${body} ${opts.marker}` : body;
  return {
    ts: new Date(tsMs).toISOString(),
    service,
    host: pickWeighted(mix32(opts.i, 11), hosts),
    level,
    message,
    attrs,
  };
}
