export {};

process.env.TOPOSCOPE_DEV = "1";

if (!process.env.TOPOSCOPE_PASSWORD) {
  process.env.TOPOSCOPE_PASSWORD = "toposcope";
}
if (!process.env.TOPOSCOPE_INGEST_TOKEN) {
  process.env.TOPOSCOPE_INGEST_TOKEN = "toposcope-ingest";
}
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

if (!process.env.SQLITE_PATH || process.env.SQLITE_PATH.startsWith("/data/")) {
  process.env.SQLITE_PATH = "./data/toposcope.sqlite";
}

const api = Bun.spawn(["bun", "--watch", "src/index.ts"], {
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
  env: process.env,
});

const ui = Bun.spawn(
  ["bun", "x", "vite", "--config", "src/ui/vite.config.ts"],
  {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
    env: process.env,
  },
);

function shutdown(): void {
  api.kill();
  ui.kill();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const [apiCode, uiCode] = await Promise.all([api.exited, ui.exited]);
process.exit(apiCode === 0 && uiCode === 0 ? 0 : 1);
