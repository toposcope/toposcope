import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pingClickHouse } from "../shared/clickhouse";
import { migrateStore } from "../shared/migrate";
import { storeSize } from "./store-size";

process.env.CLICKHOUSE_USER ??= "default";
process.env.CLICKHOUSE_PASSWORD ??= "toposcope";
process.env.CLICKHOUSE_URL ??= "http://127.0.0.1:8123";

// #201: the backup's size is the stores' own, not the host filesystem's.
let ready = false;
beforeAll(async () => {
  ready = await pingClickHouse();
  if (ready) await migrateStore();
});

describe("the stores' sizes", () => {
  test("SQLite is the file and its WAL; a store that cannot say is null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "toposcope-store-size-"));
    const path = join(dir, "toposcope.sqlite");
    writeFileSync(path, Buffer.alloc(4096));
    writeFileSync(`${path}-wal`, Buffer.alloc(1024));
    const size = await storeSize(path);
    expect(size.sqlite_bytes).toBe(5120);
    expect((await storeSize(join(dir, "missing.sqlite"))).sqlite_bytes).toBeNull();
    expect((await storeSize(":memory:")).sqlite_bytes).toBeNull();
  });

  test("ClickHouse is its active parts", async () => {
    if (!ready) return;
    const size = await storeSize(":memory:");
    expect(size.clickhouse_bytes).toBeGreaterThan(0);
  });
});
