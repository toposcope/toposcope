import { beforeAll, describe, expect, test } from "bun:test";
import { insertEvents } from "../ingest";
import { insertMetricPoints } from "../ingest/metrics";
import { pingClickHouse } from "../shared/clickhouse";
import { migrateStore } from "../shared/migrate";
import { fieldsCatalogSuggest } from "./fields-catalog";

process.env.CLICKHOUSE_USER ??= "default";
process.env.CLICKHOUSE_PASSWORD ??= "toposcope";
process.env.CLICKHOUSE_URL ??= "http://127.0.0.1:8123";

// The case of #110, one run's own values. A scheduler's `kind` happens to
// share a value with the metrics' `service`, and the logger's name with
// `host`; `sandbox_id` is a log field and a metric label of the same name,
// and a log row's `version` is the resource's `service.version`.
const run = Date.now();
const service = `billing-${run}`;
const host = `control-${run}`;
const sandbox = `sandbox-${run}`;
const version = `v0.9.${run}`;
// One whole minute, long enough ago that no other test writes into it.
const minute = Math.floor(Date.now() / 60_000) * 60_000 - 137 * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const window = { from: iso(minute), to: iso(minute + 60_000) };

let ready = false;

beforeAll(async () => {
  ready = await pingClickHouse();
  if (!ready) {
    return;
  }
  await migrateStore();
  const rows = Array.from({ length: 30 }, (_, i) => ({
    ts: iso(minute + 1_000 + i * 1_000),
    service,
    host,
    level: "info" as const,
    message: "scheduler decided",
    attrs: {
      kind: service,
      "otel.scope.name": host,
      sandbox_id: sandbox,
      version,
      shelf: sandbox,
    },
  }));
  await insertEvents(rows);
  await insertMetricPoints(
    Array.from({ length: 30 }, (_, i) => ({
      ts: iso(minute + 1_000 + i * 1_000),
      name: `link_test.disk.${run}`,
      value: i,
      labels: { service, host, sandbox_id: sandbox, "service.version": version },
    })),
  );
});

async function suggested(): Promise<Record<string, string>> {
  const { suggestLinks } = await fieldsCatalogSuggest(window, [
    "kind",
    "otel.scope.name",
    "sandbox_id",
    "version",
    "shelf",
  ]);
  return suggestLinks;
}

describe("Fields suggests a link when the names say so and the values agree", () => {
  test("a field and a label of the same name that share a value", async () => {
    if (!ready) return;
    const links = await suggested();
    expect(links.sandbox_id).toBe("sandbox_id");
    expect(links.service).toBe("service");
    expect(links.host).toBe("host");
  });

  test("a log row's version and the resource's service.version", async () => {
    if (!ready) return;
    expect((await suggested()).version).toBe("service.version");
  });

  test("a shared value under another name is not a link", async () => {
    if (!ready) return;
    const links = await suggested();
    expect(links.kind).toBeUndefined();
    expect(links["otel.scope.name"]).toBeUndefined();
    expect(links.shelf).toBeUndefined();
  });
});
