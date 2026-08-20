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
  const url = clickhouseUrl();
  url.pathname = "/ping";
  const res = await fetch(url, { headers: { Authorization: authHeader() } });
  if (!res.ok) {
    return false;
  }
  const text = (await res.text()).trim();
  return text === "Ok.";
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

const insertTables = new Set(["logs", "metrics", "spans", "profile_samples"]);

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
  });
  if (!res.ok) {
    throw new Error(`ClickHouse insert failed: ${await res.text()}`);
  }
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
