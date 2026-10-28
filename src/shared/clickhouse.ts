type ClickHouseJson<T> = {
  data: T[];
};

function clickhouseUrl(): URL {
  return new URL(process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123");
}

function authHeader(): string {
  const user = process.env.CLICKHOUSE_USER ?? "default";
  const password = process.env.CLICKHOUSE_PASSWORD ?? "";
  return `Basic ${btoa(`${user}:${password}`)}`;
}

export function toClickHouseDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid timestamp: ${iso}`);
  }
  return d.toISOString().replace("T", " ").replace("Z", "");
}

export function toIsoTimestamp(value: string): string {
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const withZone = /Z$|[+-]\d{2}:\d{2}$/.test(normalized)
    ? normalized
    : `${normalized}Z`;
  const d = new Date(withZone);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid ClickHouse timestamp: ${value}`);
  }
  return d.toISOString();
}

export async function pingClickHouse(): Promise<boolean> {
  try {
    const url = clickhouseUrl();
    url.pathname = "/ping";
    // `/ping` answers only bare: a `?database=` in CLICKHOUSE_URL would make it a 404.
    url.search = "";
    const res = await fetch(url, { headers: { Authorization: authHeader() } });
    if (!res.ok) {
      return false;
    }
    const text = (await res.text()).trim();
    return text === "Ok.";
  } catch {
    return false;
  }
}

export async function clickhouseQuery<T>(
  sql: string,
  params: Record<string, string> = {},
  options?: { signal?: AbortSignal },
): Promise<T[]> {
  const url = clickhouseUrl();
  url.searchParams.set("default_format", "JSON");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(`param_${key}`, value);
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: authHeader() },
    body: sql,
    signal: options?.signal,
  });
  if (!res.ok) {
    throw new Error(`ClickHouse query failed: ${await res.text()}`);
  }
  const json = (await res.json()) as ClickHouseJson<T>;
  return json.data;
}

const insertTables = new Set([
  "logs",
  "metrics",
  "spans",
  "profile_samples",
  "change_marks",
  "metric_kinds",
  "metric_units",
  "metric_descriptions",
  "metric_buckets",
  "arrival_seq",
  "monitor_results",
]);

/** How long an insert may take before it is given up as lost. */
export const insertTimeoutMs = 30_000;

export async function clickhouseInsertJsonEachRow(
  body: string,
  table = "logs",
): Promise<void> {
  if (!insertTables.has(table)) {
    throw new Error(`ClickHouse insert table not allowed: ${table}`);
  }
  const url = clickhouseUrl();
  url.searchParams.set("query", `INSERT INTO ${table} FORMAT JSONEachRow`);
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: authHeader() },
    body,
    // An insert answers in milliseconds; one that does not has gone to a dead connection, so it
    // fails here instead of holding its caller (a push, a run, an ingest) without end.
    signal: AbortSignal.timeout(insertTimeoutMs),
  });
  if (!res.ok) {
    throw new Error(`ClickHouse insert failed: ${await res.text()}`);
  }
}

/**
 * A query's result as ClickHouse wrote it, zstd-compressed on the wire (#327): a link's feed
 * sends Native blocks through untouched, so Bun never parses a row.
 */
export async function clickhouseQueryZstd(sql: string, params: Record<string, string> = {}): Promise<Uint8Array> {
  const url = clickhouseUrl();
  url.searchParams.set("enable_http_compression", "1");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(`param_${key}`, value);
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: authHeader(), "accept-encoding": "zstd" },
    body: sql,
    decompress: false,
  } as RequestInit);
  if (!res.ok) {
    throw new Error(`ClickHouse query failed: ${await res.text()}`);
  }
  if (res.headers.get("content-encoding") !== "zstd") {
    // An empty result can come back plain; compress it so every block reads the same way.
    return Bun.zstdCompressSync(new Uint8Array(await res.arrayBuffer()));
  }
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * An `INSERT … SELECT … FROM input(…)` whose input is a zstd body (#327). Returns how many rows
 * it wrote, from ClickHouse's own summary.
 */
export async function clickhouseInsertSelectZstd(
  sql: string,
  body: Uint8Array,
  params: Record<string, string> = {},
): Promise<number> {
  const url = clickhouseUrl();
  url.searchParams.set("query", sql);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(`param_${key}`, value);
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: authHeader(), "content-encoding": "zstd" },
    body: body as unknown as BodyInit,
    signal: AbortSignal.timeout(insertTimeoutMs),
  });
  if (!res.ok) {
    throw new Error(`ClickHouse insert failed: ${await res.text()}`);
  }
  const summary = JSON.parse(res.headers.get("x-clickhouse-summary") ?? "{}") as { written_rows?: string };
  return Number(summary.written_rows ?? 0);
}

export async function clickhouseCommand(sql: string): Promise<void> {
  const res = await fetch(clickhouseUrl(), {
    method: "POST",
    headers: { Authorization: authHeader() },
    body: sql,
  });
  if (!res.ok) {
    throw new Error(`ClickHouse command failed: ${await res.text()}`);
  }
}
