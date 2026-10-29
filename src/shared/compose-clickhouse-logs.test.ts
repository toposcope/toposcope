import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The packaged compose.yml gives ClickHouse a config.d override so its own logging does not fill
// the data volume: a stock install grew text_log alone past 4 GiB of Trace rows. The override is
// started in the ClickHouse the compose file pins, where Docker is there (CI has it).
setDefaultTimeout(120_000);

const root = `${import.meta.dir}/../..`;
type Compose = {
  services: { clickhouse: { image: string; configs: Array<{ source: string; target: string }> } };
  configs: Record<string, { content: string }>;
};
const compose = Bun.YAML.parse(readFileSync(`${root}/compose.yml`, "utf8")) as Compose;
const mount = compose.services.clickhouse.configs[0]!;
const xml = compose.configs[mount.source]!.content;
const image = compose.services.clickhouse.image;

// The system log tables Toposcope never reads and that grow with every query, part or second.
const OFF = ["text_log", "trace_log", "processors_profile_log", "query_views_log", "query_thread_log", "query_metric_log", "metric_log", "asynchronous_metric_log", "part_log"];
const KEPT = ["query_log", "error_log", "asynchronous_insert_log"];

describe("ClickHouse's own logging in compose.yml", () => {
  test("the override goes into config.d, logs warnings and up, turns off the busy logs and keeps the rest 7 days", () => {
    expect(mount.target).toMatch(/^\/etc\/clickhouse-server\/config\.d\/[a-z-]+\.xml$/);
    expect(xml).toContain("<level>warning</level>");
    for (const t of OFF) expect(xml).toContain(`<${t} remove="1"/>`);
    for (const t of KEPT) expect(xml).toMatch(new RegExp(`<${t}>\\s*<ttl>event_date \\+ INTERVAL 7 DAY DELETE</ttl>\\s*</${t}>`));
    // Compose interpolates $ in content.
    expect(xml).not.toContain("$");
  });

  const docker = Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  test.skipIf(!docker)(`${image} loads it: warning level, the busy logs absent, the kept ones with their TTL`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "toposcope-ch-logs-"));
    writeFileSync(join(dir, "override.xml"), xml);
    const name = `toposcope-ch-logs-${process.pid}`;
    const run = Bun.spawnSync(["docker", "run", "-d", "--rm", "--name", name, "-e", "CLICKHOUSE_PASSWORD=x", "-v", `${join(dir, "override.xml")}:${mount.target}:ro`, image]);
    expect(run.exitCode).toBe(0);
    const q = (sql: string) => {
      const r = Bun.spawnSync(["docker", "exec", name, "clickhouse-client", "--password", "x", "-q", sql]);
      return { ok: r.exitCode === 0, out: r.stdout.toString().trim() };
    };
    try {
      let up = false;
      for (let i = 0; i < 60 && !up; i++) {
        up = q("SELECT 1").ok;
        if (!up) await Bun.sleep(1000);
      }
      expect(up).toBe(true);
      expect(q("SELECT value FROM system.server_settings WHERE name = 'logger.level'").out).toBe("warning");
      q("SELECT count() FROM numbers(1000) FORMAT Null");
      expect(q("SYSTEM FLUSH LOGS").ok).toBe(true);
      const tables = q("SELECT name, engine_full FROM system.tables WHERE database = 'system' FORMAT JSONEachRow")
        .out.split("\n")
        .map((l) => JSON.parse(l) as { name: string; engine_full: string });
      const names = tables.map((t) => t.name);
      for (const t of OFF) expect(names).not.toContain(t);
      for (const t of KEPT) expect(tables.find((x) => x.name === t)?.engine_full).toContain("TTL event_date + toIntervalDay(7)");
    } finally {
      Bun.spawnSync(["docker", "rm", "-f", name], { stdout: "ignore", stderr: "ignore" });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
