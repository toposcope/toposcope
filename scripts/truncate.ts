import {
  clickhouseCommand,
  clickhouseQuery,
  pingClickHouse,
} from "../src/shared/clickhouse";

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

async function countLogs(): Promise<number> {
  const rows = await clickhouseQuery<{ n: string | number }>(
    "SELECT count() AS n FROM logs",
  );
  const n = rows[0]?.n ?? 0;
  return typeof n === "number" ? n : Number(n);
}

async function main(): Promise<void> {
  if (!(await pingClickHouse())) {
    throw new Error(
      `ClickHouse is not reachable at ${process.env.CLICKHOUSE_URL}`,
    );
  }
  const before = await countLogs();
  await clickhouseCommand("TRUNCATE TABLE IF EXISTS logs");
  await clickhouseCommand("TRUNCATE TABLE IF EXISTS logs_by_minute");
  await clickhouseCommand("TRUNCATE TABLE IF EXISTS logs_attr_keys_by_minute");
  await clickhouseCommand("TRUNCATE TABLE IF EXISTS logs_attr_values_by_minute");
  await clickhouseCommand("TRUNCATE TABLE IF EXISTS logs_attr_numeric_by_minute");
  await clickhouseCommand("TRUNCATE TABLE IF EXISTS metrics");
  await clickhouseCommand("TRUNCATE TABLE IF EXISTS metrics_by_minute");
  await clickhouseCommand("TRUNCATE TABLE IF EXISTS spans");
  await clickhouseCommand("TRUNCATE TABLE IF EXISTS profile_samples");
  const after = await countLogs();
  console.log(
    `truncated logs, metrics, spans, profile_samples, and rollups (${before.toLocaleString()} → ${after.toLocaleString()} rows)`,
  );
  if (after !== 0) {
    throw new Error("truncate left rows in logs");
  }
}

await main();
