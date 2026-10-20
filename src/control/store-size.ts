import { statSync } from "node:fs";
import { clickhouseQuery } from "../shared/clickhouse";
import type { StoreSize } from "../shared/releases";
import { defaultSqlitePath } from "../shared/sqlite-path";

/**
 * How big the two stores are, for the backup an upgrade takes first (#201): ClickHouse's active
 * parts, every database (the data volume holds them all), and the SQLite file with its WAL. The
 * footer's ClickHouse meter reads the host's filesystem, which is not the store. Null when a
 * store cannot say.
 */
export async function storeSize(sqlitePath: string = defaultSqlitePath()): Promise<StoreSize> {
  const clickhouse = await clickhouseQuery<{ bytes: string | number }>("SELECT sum(bytes_on_disk) AS bytes FROM system.parts WHERE active", {}, { signal: AbortSignal.timeout(3000) })
    .then((rows) => {
      const n = Number(rows[0]?.bytes);
      return Number.isFinite(n) ? n : null;
    })
    .catch(() => null);
  return { clickhouse_bytes: clickhouse, sqlite_bytes: fileBytes(sqlitePath) };
}

function fileBytes(path: string): number | null {
  if (path === ":memory:") {
    return null;
  }
  try {
    let n = statSync(path).size;
    for (const extra of [`${path}-wal`, `${path}-shm`]) {
      try {
        n += statSync(extra).size;
      } catch {
        // No WAL yet.
      }
    }
    return n;
  } catch {
    return null;
  }
}
