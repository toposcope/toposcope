import { isAttrIdent } from "./attrs";
import { clickhouseCommand, clickhouseQuery } from "./clickhouse";
import { setFieldSkipKeys } from "./field-skip";

const attrValueIndexSql = `
  lengthUTF8(value) <= 64
  AND value != ''
  AND NOT startsWith(value, '{')
  AND NOT startsWith(value, '[')
  AND NOT match(value, '^[0-9a-fA-F]{32}$')
  AND NOT match(value, '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
`;

const attrNumericIndexSql = `
  ${attrValueIndexSql}
  AND isFinite(toFloat64OrNull(value))
`;

export const attrRoleSkipSql = `key NOT IN (SELECT key FROM field_role_skip)`;

export const attrValueMvWhereSql = `${attrValueIndexSql} AND ${attrRoleSkipSql}`;

export const attrNumericMvWhereSql = `${attrNumericIndexSql} AND ${attrRoleSkipSql}`;

export function clampRetentionDays(days: number): number {
  if (Number.isNaN(days)) {
    return 30;
  }
  return Math.min(365, Math.max(1, Math.floor(days)));
}

/** Pass 23: inverted text indexes are GA from 26.2; compose pins 26.3 LTS. */
export const minClickHouseVersion = "26.3";

export function parseClickHouseVersion(raw: string): number[] {
  const match = raw.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) {
    return [];
  }
  return [
    Number(match[1]),
    Number(match[2] ?? 0),
    Number(match[3] ?? 0),
    Number(match[4] ?? 0),
  ];
}

export function clickhouseVersionAtLeast(raw: string, min: string): boolean {
  const have = parseClickHouseVersion(raw);
  const want = parseClickHouseVersion(min);
  if (have.length === 0 || want.length === 0) {
    return false;
  }
  for (let i = 0; i < want.length; i++) {
    const a = have[i] ?? 0;
    const b = want[i] ?? 0;
    if (a > b) {
      return true;
    }
    if (a < b) {
      return false;
    }
  }
  return true;
}

export async function requireClickHouseVersion(): Promise<void> {
  const rows = await clickhouseQuery<{ v: string }>("SELECT version() AS v");
  const version = rows[0]?.v ?? "";
  if (clickhouseVersionAtLeast(version, minClickHouseVersion)) {
    return;
  }
  throw new Error(
    `ClickHouse ${version || "(unknown)"} is too old for the message text index (need ${minClickHouseVersion}+). Recreate the container from compose.dev.yml: docker compose -f compose.dev.yml pull clickhouse && docker compose -f compose.dev.yml up -d clickhouse. If a 24.8 data dir refuses to start, remove the ch_data volume in dev.`,
  );
}

export const retentionTtlTables = [
  { table: "logs", clock: "ts" },
  { table: "logs_by_minute", clock: "minute" },
  { table: "logs_attr_keys_by_minute", clock: "minute" },
  { table: "logs_attr_values_by_minute", clock: "minute" },
  { table: "logs_attr_numeric_by_minute", clock: "minute" },
  { table: "metrics", clock: "ts" },
  { table: "metrics_by_minute", clock: "minute" },
  { table: "spans", clock: "ts" },
  { table: "profile_samples", clock: "ts" },
  { table: "change_marks", clock: "ts" },
] as const;

/** Do not wait for MATERIALIZE TTL. Default alter_sync=1 surfaces a corrupt-part mutation as PUT 500. */
export const retentionTtlAlterSettings =
  "SETTINGS mutations_sync = 0, alter_sync = 0";

export function retentionTtlAlterSql(
  table: (typeof retentionTtlTables)[number]["table"],
  clock: (typeof retentionTtlTables)[number]["clock"],
  days: number,
): string {
  const n = clampRetentionDays(days);
  return `ALTER TABLE ${table} MODIFY TTL toDate(${clock}) + INTERVAL ${n} DAY ${retentionTtlAlterSettings}`;
}

export const killUnfinishedTtlMutationSql =
  "KILL MUTATION WHERE database = currentDatabase() AND is_done = 0 AND command LIKE '%TTL%'";

export function parseTtlIntervalDays(engineFull: string): number | null {
  const interval = engineFull.match(/toIntervalDay\((\d+)\)/);
  if (interval?.[1]) {
    return Number(interval[1]);
  }
  const sql = engineFull.match(/INTERVAL (\d+) DAY/);
  if (sql?.[1]) {
    return Number(sql[1]);
  }
  return null;
}

export async function applyRetentionDays(days: number): Promise<void> {
  const n = clampRetentionDays(days);
  try {
    await clickhouseCommand(killUnfinishedTtlMutationSql);
  } catch {
    // A failed KILL must not block issuing the new TTL.
  }
  const have = await currentTtlIntervalDays();
  for (const spec of retentionTtlTables) {
    if (have[spec.table] === n) {
      continue;
    }
    await clickhouseCommand(retentionTtlAlterSql(spec.table, spec.clock, n));
  }
}

async function currentTtlIntervalDays(): Promise<Record<string, number | null>> {
  const names = retentionTtlTables.map((spec) => `'${spec.table}'`).join(", ");
  const rows = await clickhouseQuery<{ name: string; engine_full: string }>(
    `SELECT name, engine_full FROM system.tables WHERE database = currentDatabase() AND name IN (${names})`,
  );
  const have: Record<string, number | null> = {};
  for (const row of rows) {
    have[row.name] = parseTtlIntervalDays(row.engine_full);
  }
  return have;
}

export function isDayPartition(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** Empty ClickHouse (packaged compose has no init.sql mount). */
export const logsCreateTableSql = `CREATE TABLE IF NOT EXISTS logs (
  tenant_id LowCardinality(String) DEFAULT 'default',
  ts DateTime64(3, 'UTC'),
  service LowCardinality(String),
  host LowCardinality(String) DEFAULT '',
  level LowCardinality(String),
  message String,
  attrs String DEFAULT '{}',
  attr_map Map(LowCardinality(String), String) DEFAULT map(),
  trace_id String DEFAULT '',
  INDEX idx_trace_id_bf trace_id TYPE bloom_filter(0.01) GRANULARITY 1,
  INDEX idx_attr_vals_bf mapValues(attr_map) TYPE bloom_filter(0.01) GRANULARITY 1,
  INDEX idx_message_text lowerUTF8(message) TYPE text(tokenizer = 'splitByNonAlpha') GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (tenant_id, service, ts)
TTL toDate(ts) + INTERVAL 30 DAY`;

async function ensureLogs(): Promise<void> {
  await clickhouseCommand(logsCreateTableSql);
}

export async function migrateStore(): Promise<void> {
  console.error("migrate: ClickHouse schema");
  await requireClickHouseVersion();
  await ensureLogs();
  await clickhouseCommand(
    "ALTER TABLE logs ADD COLUMN IF NOT EXISTS attr_map Map(LowCardinality(String), String) DEFAULT map()",
  );
  await clickhouseCommand(
    "ALTER TABLE logs ADD COLUMN IF NOT EXISTS trace_id String DEFAULT ''",
  );
  await backfillAttrMap();
  await dropUnusedAttrColumns();
  await ensureFieldRoleSkip();
  await ensureLogsBloomIndexes();
  await ensureLogsMessageTextIndex();
  await ensureLogsByMinute();
  await ensureAttrKeysByMinute();
  await ensureAttrValuesByMinute();
  await ensureAttrNumericByMinute();
  await ensureMetrics();
  await ensureSpans();
  await ensureProfileSamples();
  await ensureChangeMarks();
  await backfillHistogramIfEmpty();
  await backfillAttrKeysIfEmpty();
  await backfillAttrValuesMissing();
  await backfillAttrNumericMissing();
  console.error("migrate: done");
}

const flattenMapSql = `mapFromArrays(
  arrayMap(k -> lowerUTF8(k), JSONExtractKeys(attrs)),
  arrayMap(k -> JSONExtractString(attrs, k), JSONExtractKeys(attrs))
)`;

async function tableHasColumn(table: string, column: string): Promise<boolean> {
  try {
    const cols = await clickhouseQuery<{ name: string }>(
      `DESCRIBE TABLE ${table}`,
    );
    return cols.some((col) => col.name === column);
  } catch {
    return false;
  }
}

async function tableHasSkipIndex(table: string, name: string): Promise<boolean> {
  const rows = await clickhouseQuery<{ name: string }>(
    `SELECT name FROM system.data_skipping_indices
     WHERE database = currentDatabase() AND table = {table:String} AND name = {name:String}`,
    { table, name },
  );
  return rows.length > 0;
}

async function ensureSkipIndex(
  table: string,
  name: string,
  expr: string,
): Promise<void> {
  if (await tableHasSkipIndex(table, name)) {
    return;
  }
  await clickhouseCommand(`ALTER TABLE ${table} ADD INDEX ${name} ${expr}`);
  await clickhouseCommand(`ALTER TABLE ${table} MATERIALIZE INDEX ${name}`);
}

export const messageTextIndexSql =
  "lowerUTF8(message) TYPE text(tokenizer = 'splitByNonAlpha') GRANULARITY 1";

async function ensureLogsBloomIndexes(): Promise<void> {
  await ensureSkipIndex(
    "logs",
    "idx_trace_id_bf",
    "trace_id TYPE bloom_filter(0.01) GRANULARITY 1",
  );
  await ensureSkipIndex(
    "logs",
    "idx_attr_vals_bf",
    "mapValues(attr_map) TYPE bloom_filter(0.01) GRANULARITY 1",
  );
}

async function ensureLogsMessageTextIndex(): Promise<void> {
  await ensureSkipIndex("logs", "idx_message_text", messageTextIndexSql);
}

async function dropUnusedAttrColumns(): Promise<void> {
  for (const column of ["attr_path", "attr_status", "attr_user_id"]) {
    if (await tableHasColumn("logs", column)) {
      await clickhouseCommand(`ALTER TABLE logs DROP COLUMN IF EXISTS ${column}`);
    }
  }
}

export async function ensureFieldRoleSkip(): Promise<void> {
  await clickhouseCommand(`
    CREATE TABLE IF NOT EXISTS field_role_skip (
      key String
    )
    ENGINE = ReplacingMergeTree
    ORDER BY key
  `);
}

export async function syncFieldRoleSkip(keys: string[]): Promise<void> {
  await ensureFieldRoleSkip();
  await clickhouseCommand("TRUNCATE TABLE field_role_skip");
  const valid = keys.filter((key) => isAttrIdent(key));
  setFieldSkipKeys(valid);
  if (valid.length === 0) {
    return;
  }
  const values = valid
    .map((key) => `('${key.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}')`)
    .join(",");
  await clickhouseCommand(`INSERT INTO field_role_skip (key) VALUES ${values}`);
}

async function ensureLogsByMinute(): Promise<void> {
  if (!(await tableHasColumn("logs_by_minute", "host"))) {
    await clickhouseCommand("DROP VIEW IF EXISTS logs_by_minute_mv");
    await clickhouseCommand("DROP TABLE IF EXISTS logs_by_minute");
    await clickhouseCommand(`
      CREATE TABLE logs_by_minute (
        tenant_id LowCardinality(String),
        minute DateTime('UTC'),
        service LowCardinality(String),
        level LowCardinality(String),
        host LowCardinality(String),
        n AggregateFunction(count)
      )
      ENGINE = AggregatingMergeTree
      PARTITION BY toDate(minute)
      ORDER BY (tenant_id, minute, service, level, host)
      TTL toDate(minute) + INTERVAL 30 DAY
    `);
  }
  await clickhouseCommand("DROP VIEW IF EXISTS logs_by_minute_mv");
  await clickhouseCommand(`
    CREATE MATERIALIZED VIEW logs_by_minute_mv TO logs_by_minute AS
    SELECT
      tenant_id,
      toStartOfMinute(ts) AS minute,
      service,
      level,
      host,
      countState() AS n
    FROM logs
    GROUP BY tenant_id, minute, service, level, host
  `);
}

async function ensureAttrKeysByMinute(): Promise<void> {
  const order = "tenant_id, minute, service, level, host, key";
  const sorting = await tableSortingKey("logs_attr_keys_by_minute");
  if (sorting !== order) {
    await clickhouseCommand("DROP VIEW IF EXISTS logs_attr_keys_by_minute_mv");
    await clickhouseCommand("DROP TABLE IF EXISTS logs_attr_keys_by_minute");
    await clickhouseCommand(`
      CREATE TABLE logs_attr_keys_by_minute (
        tenant_id LowCardinality(String),
        minute DateTime('UTC'),
        service LowCardinality(String),
        level LowCardinality(String),
        host LowCardinality(String),
        key LowCardinality(String),
        n AggregateFunction(count)
      )
      ENGINE = AggregatingMergeTree
      PARTITION BY toDate(minute)
      ORDER BY (tenant_id, minute, service, level, host, key)
      TTL toDate(minute) + INTERVAL 30 DAY
    `);
  }
  await clickhouseCommand("DROP VIEW IF EXISTS logs_attr_keys_by_minute_mv");
  await clickhouseCommand(`
    CREATE MATERIALIZED VIEW logs_attr_keys_by_minute_mv TO logs_attr_keys_by_minute AS
    SELECT
      tenant_id,
      toStartOfMinute(ts) AS minute,
      service,
      level,
      host,
      key,
      countState() AS n
    FROM logs
    ARRAY JOIN mapKeys(attr_map) AS key
    GROUP BY tenant_id, minute, service, level, host, key
  `);
}

async function ensureAttrValuesByMinute(): Promise<void> {
  await clickhouseCommand(`
    CREATE TABLE IF NOT EXISTS logs_attr_values_by_minute (
      tenant_id LowCardinality(String),
      minute DateTime('UTC'),
      service LowCardinality(String),
      level LowCardinality(String),
      host LowCardinality(String),
      key LowCardinality(String),
      value String,
      n AggregateFunction(count)
    )
    ENGINE = AggregatingMergeTree
    PARTITION BY toDate(minute)
    ORDER BY (tenant_id, minute, key, value, service, host, level)
    TTL toDate(minute) + INTERVAL 30 DAY
  `);
  await clickhouseCommand("DROP VIEW IF EXISTS logs_attr_values_by_minute_mv");
  await clickhouseCommand(`
    CREATE MATERIALIZED VIEW logs_attr_values_by_minute_mv TO logs_attr_values_by_minute AS
    SELECT
      tenant_id,
      toStartOfMinute(ts) AS minute,
      service,
      level,
      host,
      key,
      value,
      countState() AS n
    FROM logs
    ARRAY JOIN mapKeys(attr_map) AS key, mapValues(attr_map) AS value
    WHERE ${attrValueMvWhereSql}
    GROUP BY tenant_id, minute, service, level, host, key, value
  `);
}

async function ensureAttrNumericByMinute(): Promise<void> {
  const order = "(tenant_id, key, minute, service, host, level)";
  const sorting = await tableSortingKey("logs_attr_numeric_by_minute");
  if (sorting !== "tenant_id, key, minute, service, host, level") {
    await clickhouseCommand("DROP VIEW IF EXISTS logs_attr_numeric_by_minute_mv");
    await clickhouseCommand("DROP TABLE IF EXISTS logs_attr_numeric_by_minute");
  }
  await clickhouseCommand(`
    CREATE TABLE IF NOT EXISTS logs_attr_numeric_by_minute (
      tenant_id LowCardinality(String),
      minute DateTime('UTC'),
      service LowCardinality(String),
      level LowCardinality(String),
      host LowCardinality(String),
      key LowCardinality(String),
      n AggregateFunction(count),
      v_sum AggregateFunction(sum, Float64),
      v_min AggregateFunction(min, Float64),
      v_max AggregateFunction(max, Float64),
      v_p99 AggregateFunction(quantileTDigest(0.99), Float64)
    )
    ENGINE = AggregatingMergeTree
    PARTITION BY toDate(minute)
    ORDER BY ${order}
    TTL toDate(minute) + INTERVAL 30 DAY
  `);
  await clickhouseCommand("DROP VIEW IF EXISTS logs_attr_numeric_by_minute_mv");
  await clickhouseCommand(`
    CREATE MATERIALIZED VIEW logs_attr_numeric_by_minute_mv TO logs_attr_numeric_by_minute AS
    SELECT
      tenant_id,
      toStartOfMinute(ts) AS minute,
      service,
      level,
      host,
      key,
      countState() AS n,
      sumState(toFloat64(value)) AS v_sum,
      minState(toFloat64(value)) AS v_min,
      maxState(toFloat64(value)) AS v_max,
      quantileTDigestState(0.99)(toFloat64(value)) AS v_p99
    FROM logs
    ARRAY JOIN mapKeys(attr_map) AS key, mapValues(attr_map) AS value
    WHERE ${attrNumericMvWhereSql}
    GROUP BY tenant_id, minute, service, level, host, key
  `);
}

async function ensureMetrics(): Promise<void> {
  await clickhouseCommand(`
    CREATE TABLE IF NOT EXISTS metrics (
      tenant_id LowCardinality(String),
      ts DateTime64(3, 'UTC'),
      name LowCardinality(String),
      value Float64,
      labels Map(LowCardinality(String), String)
    )
    ENGINE = MergeTree
    PARTITION BY toDate(ts)
    ORDER BY (tenant_id, name, ts)
    TTL toDate(ts) + INTERVAL 30 DAY
  `);
  await clickhouseCommand(`
    CREATE TABLE IF NOT EXISTS metrics_by_minute (
      tenant_id LowCardinality(String),
      minute DateTime('UTC'),
      name LowCardinality(String),
      n AggregateFunction(count),
      v_sum AggregateFunction(sum, Float64),
      v_min AggregateFunction(min, Float64),
      v_max AggregateFunction(max, Float64)
    )
    ENGINE = AggregatingMergeTree
    PARTITION BY toDate(minute)
    ORDER BY (tenant_id, name, minute)
    TTL toDate(minute) + INTERVAL 30 DAY
  `);
  await clickhouseCommand("DROP VIEW IF EXISTS metrics_by_minute_mv");
  await clickhouseCommand(`
    CREATE MATERIALIZED VIEW metrics_by_minute_mv TO metrics_by_minute AS
    SELECT
      tenant_id,
      toStartOfMinute(ts) AS minute,
      name,
      countState() AS n,
      sumState(value) AS v_sum,
      minState(value) AS v_min,
      maxState(value) AS v_max
    FROM metrics
    GROUP BY tenant_id, minute, name
  `);
}

async function ensureSpans(): Promise<void> {
  await clickhouseCommand(`
    CREATE TABLE IF NOT EXISTS spans (
      tenant_id LowCardinality(String),
      trace_id String,
      span_id String,
      parent_span_id String,
      service LowCardinality(String),
      name String,
      ts DateTime64(3, 'UTC'),
      duration_ms Float64,
      status LowCardinality(String),
      attrs Map(LowCardinality(String), String)
    )
    ENGINE = MergeTree
    PARTITION BY toDate(ts)
    ORDER BY (tenant_id, trace_id, ts)
    TTL toDate(ts) + INTERVAL 30 DAY
  `);
}

async function ensureProfileSamples(): Promise<void> {
  await clickhouseCommand(`
    CREATE TABLE IF NOT EXISTS profile_samples (
      tenant_id LowCardinality(String),
      profile_id String,
      service LowCardinality(String),
      ts DateTime64(3, 'UTC'),
      duration_ms Float64,
      sample_type LowCardinality(String),
      sample_unit LowCardinality(String),
      period_type LowCardinality(String),
      period_unit LowCardinality(String),
      trace_id String,
      span_id String,
      frames Array(String),
      value Float64
    )
    ENGINE = MergeTree
    PARTITION BY toDate(ts)
    ORDER BY (tenant_id, trace_id, span_id, ts)
    TTL toDate(ts) + INTERVAL 30 DAY
  `);
}

async function ensureChangeMarks(): Promise<void> {
  await clickhouseCommand(`
    CREATE TABLE IF NOT EXISTS change_marks (
      tenant_id LowCardinality(String),
      ts DateTime64(3, 'UTC'),
      kind LowCardinality(String),
      service LowCardinality(String),
      title String,
      attrs Map(LowCardinality(String), String)
    )
    ENGINE = MergeTree
    PARTITION BY toDate(ts)
    ORDER BY (tenant_id, ts, kind)
    TTL toDate(ts) + INTERVAL 30 DAY
  `);
}

async function tableSortingKey(table: string): Promise<string | null> {
  try {
    const rows = await clickhouseQuery<{ sorting_key: string }>(
      `
      SELECT sorting_key
      FROM system.tables
      WHERE database = currentDatabase() AND name = {table:String}
      `,
      { table },
    );
    return rows[0]?.sorting_key ?? null;
  } catch {
    return null;
  }
}

async function activeDayPartitions(table: string): Promise<string[]> {
  const rows = await clickhouseQuery<{ partition: string }>(
    `
    SELECT partition
    FROM system.parts
    WHERE database = currentDatabase() AND table = {table:String} AND active
    GROUP BY partition
    ORDER BY partition
    `,
    { table },
  );
  return rows.map((row) => row.partition).filter(isDayPartition);
}

async function backfillDays(
  label: string,
  sourceTable: string,
  destTable: string,
  insertSql: (day: string) => string,
): Promise<void> {
  const have = new Set(await activeDayPartitions(destTable));
  const missing = (await activeDayPartitions(sourceTable)).filter(
    (day) => !have.has(day),
  );
  for (let i = 0; i < missing.length; i++) {
    const day = missing[i];
    if (day === undefined) {
      continue;
    }
    console.error(`migrate: ${label} ${day} (${i + 1}/${missing.length})`);
    await clickhouseCommand(insertSql(day));
  }
}

async function backfillAttrMap(): Promise<void> {
  const rows = await clickhouseQuery<{ ok: number }>(`
    SELECT 1 AS ok FROM logs
    WHERE length(attr_map) = 0 AND attrs != '{}' AND attrs != ''
    LIMIT 1
    SETTINGS max_rows_to_read = 1000000, read_overflow_mode = 'break', max_execution_time = 15
  `);
  if (rows.length === 0) {
    return;
  }
  console.error("migrate: backfill attr_map");
  await clickhouseCommand(`
    ALTER TABLE logs UPDATE
      attr_map = ${flattenMapSql},
      attrs = toJSONString(${flattenMapSql})
    WHERE length(attr_map) = 0 AND attrs != '{}' AND attrs != ''
    SETTINGS mutations_sync = 1
  `);
}

async function backfillHistogramIfEmpty(): Promise<void> {
  await backfillDays("logs_by_minute", "logs", "logs_by_minute", (day) => `
    INSERT INTO logs_by_minute
    SELECT
      tenant_id,
      toStartOfMinute(ts) AS minute,
      service,
      level,
      host,
      countState()
    FROM logs
    WHERE toDate(ts) = toDate('${day}')
    GROUP BY tenant_id, minute, service, level, host
    SETTINGS max_execution_time = 120
  `);
}

async function backfillAttrKeysIfEmpty(): Promise<void> {
  await backfillDays(
    "attr keys",
    "logs",
    "logs_attr_keys_by_minute",
    (day) => `
    INSERT INTO logs_attr_keys_by_minute
    SELECT
      tenant_id,
      toStartOfMinute(ts) AS minute,
      service,
      level,
      host,
      key,
      countState()
    FROM logs
    ARRAY JOIN mapKeys(attr_map) AS key
    WHERE toDate(ts) = toDate('${day}')
    GROUP BY tenant_id, minute, service, level, host, key
    SETTINGS max_execution_time = 120
  `,
  );
}

async function backfillAttrValuesMissing(): Promise<void> {
  await backfillDays(
    "attr values",
    "logs",
    "logs_attr_values_by_minute",
    (day) => `
    INSERT INTO logs_attr_values_by_minute
    SELECT
      tenant_id,
      toStartOfMinute(ts) AS minute,
      service,
      level,
      host,
      key,
      value,
      countState()
    FROM logs
    ARRAY JOIN mapKeys(attr_map) AS key, mapValues(attr_map) AS value
    WHERE toDate(ts) = toDate('${day}')
      AND ${attrValueMvWhereSql}
    GROUP BY tenant_id, minute, service, level, host, key, value
    SETTINGS max_execution_time = 120
  `,
  );
}

async function backfillAttrNumericMissing(): Promise<void> {
  await backfillDays(
    "attr numeric",
    "logs",
    "logs_attr_numeric_by_minute",
    (day) => `
    INSERT INTO logs_attr_numeric_by_minute
    SELECT
      tenant_id,
      toStartOfMinute(ts) AS minute,
      service,
      level,
      host,
      key,
      countState(),
      sumState(toFloat64(value)),
      minState(toFloat64(value)),
      maxState(toFloat64(value)),
      quantileTDigestState(0.99)(toFloat64(value))
    FROM logs
    ARRAY JOIN mapKeys(attr_map) AS key, mapValues(attr_map) AS value
    WHERE toDate(ts) = toDate('${day}')
      AND ${attrNumericMvWhereSql}
    GROUP BY tenant_id, minute, service, level, host, key
    SETTINGS max_execution_time = 180
  `,
  );
}
