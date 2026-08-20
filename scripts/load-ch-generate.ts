import {
  clickhouseCommand,
  clickhouseQuery,
  pingClickHouse,
} from "../src/shared/clickhouse";
import { fakeClientNets } from "../src/shared/fake-event";

const GOLDEN = 2654435769;
const MIX2 = 0x21f0aaad;
const U32 = 4294967295;

export type GenerateOpts = {
  n: number;
  nowMs: number;
  windowMs: number;
  marker: string;
};

function mixCols(salt: number, alias: string, iExpr = "i"): string {
  const a = `${alias}_a`;
  const b = `${alias}_b`;
  const c = `${alias}_c`;
  return `toUInt32(bitAnd(toUInt64(bitXor(${iExpr}, ${salt})) * ${GOLDEN}, ${U32})) AS ${a},
    toUInt32(bitXor(${a}, bitShiftRight(${a}, 16))) AS ${b},
    toUInt32(bitAnd(toUInt64(${b}) * ${MIX2}, ${U32})) AS ${c},
    toUInt32(bitXor(${c}, bitShiftRight(${c}, 15))) AS ${alias}`;
}

function sqlString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

/** Same weighted /16s + 40% hot / 60% /16 tail as `clientIp` in `fake-event.ts`. */
function clientIpSql(netExpr: string, hostExpr: string): string {
  const total = fakeClientNets.reduce((sum, net) => sum + net.w, 0);
  let acc = 0;
  const aParts: string[] = [];
  const bParts: string[] = [];
  for (let i = 0; i < fakeClientNets.length - 1; i++) {
    const net = fakeClientNets[i];
    if (!net) {
      throw new Error("fakeClientNets gap");
    }
    acc += net.w;
    aParts.push(`${netExpr} % ${total} < ${acc}, ${net.a}`);
    bParts.push(`${netExpr} % ${total} < ${acc}, ${net.b}`);
  }
  const last = fakeClientNets[fakeClientNets.length - 1];
  if (!last) {
    throw new Error("fakeClientNets empty");
  }
  const x = `(${hostExpr} % 1000)`;
  const hotRank = `least(toUInt32(intDiv(${x} * ${x}, 15625)), 63)`;
  const coldD = `bitAnd(${hostExpr}, 255)`;
  return `concat(
    toString(multiIf(${aParts.join(", ")}, ${last.a})),
    '.',
    toString(multiIf(${bParts.join(", ")}, ${last.b})),
    '.',
    toString(if(
      ${hostExpr} % 100 < 40,
      1 + intDiv(${hotRank}, 8),
      bitAnd(bitShiftRight(${hostExpr}, 8), 255)
    )),
    '.',
    toString(if(
      ${hostExpr} % 100 < 40,
      1 + (${hotRank} % 8) * 17,
      if(${coldD} = 0, 1, if(${coldD} = 255, 254, ${coldD}))
    ))
  )`;
}

/** Same mix32 / weighted tables as `fakeLogEvent`, evaluated in ClickHouse. */
export function fakeLogsSelectSql(
  offset: number,
  count: number,
  opts: GenerateOpts,
): string {
  const n = Math.max(1, opts.n);
  return `SELECT
    toUInt32(number) AS i,
    ${mixCols(1, "m1")},
    ${mixCols(2, "m2")},
    ${mixCols(3, "m3")},
    ${mixCols(4, "m4")},
    ${mixCols(5, "m5")},
    ${mixCols(6, "m6")},
    ${mixCols(7, "m7")},
    ${mixCols(8, "m8")},
    ${mixCols(9, "m9")},
    ${mixCols(10, "m10")},
    ${mixCols(11, "m11")},
    ${mixCols(12, "m12")},
    toUInt64(${opts.nowMs} - toFloat64(number) * ${opts.windowMs} / ${n}) AS ts_ms,
    ${mixCols(91, "m91", "toUInt32(intDiv(ts_ms, 60000))")},
    fromUnixTimestamp64Milli(toInt64(ts_ms), 'UTC') AS ts,
    if(m1 % 100 < 48, 'api', if(m1 % 100 < 72, 'web', if(m1 % 100 < 90, 'worker', 'billing'))) AS service,
    if(
      service = 'api',
      if(m11 % 100 < 55, 'api-1', if(m11 % 100 < 85, 'api-2', 'api-3')),
      if(
        service = 'web',
        if(m11 % 100 < 70, 'web-1', 'web-2'),
        if(service = 'worker', if(m11 % 100 < 80, 'worker-1', 'worker-2'), 'billing-1')
      )
    ) AS host,
    if(
      (m91 % 11) = 0,
      multiIf(m2 % 100 < 42, 'error', m2 % 100 < 70, 'warn', m2 % 100 < 88, 'info', m2 % 100 < 96, 'fatal', 'debug'),
      multiIf(m2 % 100 < 68, 'info', m2 % 100 < 86, 'debug', m2 % 100 < 96, 'warn', m2 % 100 < 99, 'error', 'fatal')
    ) AS level,
    multiIf(
      m4 % 100 < 36, '/v1/items',
      m4 % 100 < 54, '/v1/checkout',
      m4 % 100 < 68, '/api/search',
      m4 % 100 < 78, '/v1/logs',
      m4 % 100 < 88, '/health',
      m4 % 100 < 96, '/v1/users',
      '/internal/jobs'
    ) AS path,
    if(
      level IN ('error', 'fatal'),
      multiIf(m5 % 100 < 45, 500, m5 % 100 < 75, 502, 503),
      if(
        level = 'warn',
        multiIf(m5 % 100 < 40, 429, m5 % 100 < 65, 400, m5 % 100 < 85, 401, 404),
        multiIf(m5 % 100 < 82, 200, m5 % 100 < 92, 201, 204)
      )
    ) AS status,
    (m6 % 180) + 8 AS duration_base,
    if(
      level IN ('error', 'fatal'),
      duration_base + 400 + (m6 % 900),
      if(level = 'warn', duration_base + 120, duration_base)
    ) AS duration_ms,
    concat('req-', if(m7 = 0, '0', lower(trim(LEADING '0' FROM hex(m7))))) AS request_id,
    concat('u-', toString(least(toUInt32((m9 % 10000) / 125), 79))) AS user_id,
    ${clientIpSql("m10", "m12")} AS client_ip,
    concat(
      if(
        level = 'debug',
        arrayElement(['cache miss', 'retrying job', 'health check ok'], (m3 % 3) + 1),
        if(
          level = 'info',
          arrayElement(['request completed', 'connected', 'user login', 'health check ok'], (m3 % 4) + 1),
          if(
            level = 'warn',
            arrayElement(['rate limited', 'timeout', 'cache miss'], (m3 % 3) + 1),
            if(
              level = 'error',
              arrayElement(['timeout', 'upstream 502', 'panic recovered'], (m3 % 3) + 1),
              arrayElement(['panic recovered', 'upstream 502'], (m3 % 2) + 1)
            )
          )
        )
      ),
      ' ',
      ${sqlString(opts.marker)}
    ) AS message,
    if(
      m8 % 5 < 3,
      map(
        'path', path,
        'status', toString(status),
        'duration_ms', toString(duration_ms),
        'request_id', request_id,
        'client_ip', client_ip,
        'user_id', user_id
      ),
      map(
        'path', path,
        'status', toString(status),
        'duration_ms', toString(duration_ms),
        'request_id', request_id,
        'client_ip', client_ip
      )
    ) AS attr_map
  FROM numbers(${offset}, ${count})`;
}

export function fakeLogsInsertSql(
  offset: number,
  count: number,
  opts: GenerateOpts,
): string {
  return `INSERT INTO logs (tenant_id, ts, service, host, level, message, attrs, attr_map, trace_id)
SELECT
  'default',
  ts,
  service,
  host,
  level,
  message,
  toJSONString(attr_map),
  attr_map,
  request_id
FROM (
  ${fakeLogsSelectSql(offset, count, opts)}
)
SETTINGS
  max_execution_time = 0,
  max_insert_threads = 2,
  max_threads = 2,
  max_memory_usage = 6000000000,
  min_insert_block_size_rows = 1048576,
  max_partitions_per_insert_block = 100`;
}

export function mix32SelectSql(i: number, salt: number): string {
  return `SELECT mix FROM (
    SELECT
      toUInt32(${i >>> 0}) AS i,
      ${mixCols(salt >>> 0, "mix")}
  )`;
}

export function ensureClickHouseEnv(): void {
  if (!process.env.CLICKHOUSE_USER) {
    process.env.CLICKHOUSE_USER = "default";
  }
  if (!process.env.CLICKHOUSE_PASSWORD) {
    process.env.CLICKHOUSE_PASSWORD = "toposcope";
  }
  if (!process.env.CLICKHOUSE_URL) {
    process.env.CLICKHOUSE_URL = "http://127.0.0.1:8123";
  } else {
    try {
      const url = new URL(process.env.CLICKHOUSE_URL);
      if (url.hostname === "clickhouse") {
        url.hostname = "127.0.0.1";
        process.env.CLICKHOUSE_URL = url.toString().replace(/\/$/, "");
      }
    } catch {
      process.env.CLICKHOUSE_URL = "http://127.0.0.1:8123";
    }
  }
}

async function tableBytes(table: string): Promise<{ bytes: number; rows: number }> {
  const rows = await clickhouseQuery<{ b: string | number; r: string | number }>(`
    SELECT
      sum(bytes_on_disk) AS b,
      sum(rows) AS r
    FROM system.parts
    WHERE database = currentDatabase() AND table = {table:String} AND active
  `, { table });
  const row = rows[0];
  return {
    bytes: Number(row?.b ?? 0),
    rows: Number(row?.r ?? 0),
  };
}

async function freeDiskBytes(): Promise<number> {
  const rows = await clickhouseQuery<{ n: string | number }>(`
    SELECT free_space AS n FROM system.disks WHERE name = 'default' LIMIT 1
  `);
  return Number(rows[0]?.n ?? 0);
}

function formatBytes(n: number): string {
  if (n >= 1_000_000_000_000) {
    return `${(n / 1_000_000_000_000).toFixed(1)}TB`;
  }
  if (n >= 1_000_000_000) {
    return `${(n / 1_000_000_000).toFixed(1)}GB`;
  }
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(0)}MB`;
  }
  return `${n}B`;
}

async function withMergesStopped(fn: () => Promise<void>): Promise<void> {
  try {
    await clickhouseCommand("SYSTEM STOP MERGES logs");
  } catch (err) {
    console.warn(`stop merges: ${err instanceof Error ? err.message : err}`);
  }
  try {
    await fn();
  } finally {
    try {
      await clickhouseCommand("SYSTEM START MERGES logs");
    } catch (err) {
      console.warn(`start merges: ${err instanceof Error ? err.message : err}`);
    }
  }
}

export async function generateLogsInClickHouse(
  opts: GenerateOpts,
): Promise<void> {
  ensureClickHouseEnv();
  if (!(await pingClickHouse())) {
    throw new Error(
      `ClickHouse is not reachable at ${process.env.CLICKHOUSE_URL}`,
    );
  }
  const skipDisk = process.env.LOAD_SKIP_DISK_CHECK === "1";
  const chunk = Math.max(
    100_000,
    Number(process.env.LOAD_CHUNK ?? 5_000_000) || 5_000_000,
  );
  const probe = Math.min(1_000_000, opts.n);
  const before = await tableBytes("logs");
  const free = await freeDiskBytes();
  console.log(
    `  ClickHouse disk free ${formatBytes(free)}; existing logs ${before.rows.toLocaleString()} rows (${formatBytes(before.bytes)})`,
  );
  if (before.rows > 0) {
    console.log(
      `  warning: this run appends ${opts.n.toLocaleString()} rows. bun run truncate first for a clean load`,
    );
  }

  await withMergesStopped(async () => {
    const ingestT0 = performance.now();
    let done = 0;
    const insertSlice = async (offset: number, count: number): Promise<void> => {
      await clickhouseCommand(fakeLogsInsertSql(offset, count, opts));
      done += count;
      const elapsed = (performance.now() - ingestT0) / 1000;
      const rate = done / Math.max(elapsed, 0.001);
      const remain = (opts.n - done) / rate;
      console.log(
        `  inserted ${done.toLocaleString()}/${opts.n.toLocaleString()} (${rate.toFixed(0)}/s, ~${(remain / 60).toFixed(0)}m left)`,
      );
    };

    await insertSlice(0, probe);
    const afterProbe = await tableBytes("logs");
    const addedBytes = Math.max(0, afterProbe.bytes - before.bytes);
    const perRow = addedBytes / probe;
    const estimated = perRow * opts.n;
    if (addedBytes === 0) {
      console.log("  part size not visible yet; skipping disk estimate");
    } else {
      console.log(
        `  ~${formatBytes(perRow)}/row compressed → ~${formatBytes(estimated)} for ${opts.n.toLocaleString()} events`,
      );
      if (!skipDisk && estimated > free * 0.85) {
        throw new Error(
          `estimated ${formatBytes(estimated)} needs more than 85% of free disk (${formatBytes(free)}). Truncate, free space, or set LOAD_SKIP_DISK_CHECK=1`,
        );
      }
    }

    for (let offset = probe; offset < opts.n; offset += chunk) {
      await insertSlice(offset, Math.min(chunk, opts.n - offset));
    }
  });
}
