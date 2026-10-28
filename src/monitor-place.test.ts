import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { migrateControlDb } from "./control/index";
import { defaultHost, readPlace, serviceRequired } from "./control/monitor-place";
import type { AlertRule } from "./control/alerts";

const unnamed = { id: "m", name: "m", service: "", host: "" } as unknown as AlertRule;

describe("a monitor names its service and host (#335)", () => {
  test("a monitor cannot be saved without a service", () => {
    expect(readPlace({ name: "api health" }, null)).toEqual({ error: serviceRequired });
    expect(readPlace({ threshold: 3 }, unnamed)).toEqual({ error: serviceRequired });
    expect(readPlace({ service: "  " }, null)).toEqual({ error: serviceRequired });
  });

  test("an HTTP monitor's host is its URL's until changed; TCP and certificate take their target's", () => {
    expect(readPlace({ service: "api", url: "https://api.example.com/health" }, null)).toEqual({ service: "api", host: "api.example.com" });
    expect(readPlace({ service: "api", http: { url: "https://api.example.com/health" } }, null)).toMatchObject({ host: "api.example.com" });
    expect(readPlace({ service: "api", url: "https://api.example.com/health", host: "api-1" }, null)).toMatchObject({ host: "api-1" });
    expect(defaultHost({ target: "billing-db:5432" }, null)).toBe("billing-db");
    expect(defaultHost({ target: "[::1]:443" }, null)).toBe("::1");
  });

  test("a save that leaves them out keeps what the monitor had", () => {
    const named = { ...unnamed, service: "billing", host: "billing-7" } as AlertRule;
    expect(readPlace({ threshold: 9 }, named)).toEqual({ service: "billing", host: "billing-7" });
  });
});

describe("monitors made before 0.10 are not kept (#335)", () => {
  const keyed = [
    ["monitor_calls", "monitor_id"],
    ["monitor_stretches", "monitor_id"],
    ["monitor_results", "monitor_id"],
    ["monitor_http", "monitor_id"],
    ["monitor_net", "monitor_id"],
    ["alert_sent_fingerprints", "rule_id"],
  ] as const;

  function monitor(db: Database, id: string, service: string): void {
    db.query(
      "INSERT INTO alert_rules (id, name, query, created_at, source, service, silenced_until) VALUES (?, ?, '', 1, 'http', ?, 9)",
    ).run(id, id, service);
    db.query("INSERT INTO monitor_calls (monitor_id, stretch_id, at, what, status) VALUES (?, ?, 1, 'open', 'sent')").run(id, `s-${id}`);
    db.query("INSERT INTO monitor_stretches (id, monitor_id, opened_at, last_at) VALUES (?, ?, 1, 1)").run(`s-${id}`, id);
    db.query("INSERT INTO monitor_results (monitor_id, minute, at, result) VALUES (?, 1, 1, 'ok')").run(id);
    db.query("INSERT INTO monitor_http (monitor_id, url) VALUES (?, 'https://api.example.com/health')").run(id);
    db.query("INSERT INTO monitor_net (monitor_id, target) VALUES (?, 'db.internal:5432')").run(id);
    db.query("INSERT INTO alert_sent_fingerprints (rule_id, mark_id, e1, sent_at) VALUES (?, 'mk', 'e', 1)").run(id);
  }

  const count = (db: Database, table: string, key: string, id: string) =>
    (db.query(`SELECT count(*) AS n FROM ${table} WHERE ${key} = ?`).get(id) as { n: number }).n;

  test("one without a service goes at startup with what hangs off it; one with a service stays", () => {
    const db = new Database(":memory:");
    migrateControlDb(db);
    monitor(db, "old", "");
    monitor(db, "blank", "  ");
    monitor(db, "api", "api");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      migrateControlDb(db);
      expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
        "Removed 2 monitors made before 0.10, which named no service: make them again in Watch.",
      ]);
      for (const id of ["old", "blank"]) {
        expect(count(db, "alert_rules", "id", id)).toBe(0);
        for (const [table, key] of keyed) {
          expect(count(db, table, key, id)).toBe(0);
        }
      }
      expect(db.query("SELECT service, silenced_until FROM alert_rules WHERE id = 'api'").get()).toEqual({ service: "api", silenced_until: 9 });
      for (const [table, key] of keyed) {
        expect(count(db, table, key, "api")).toBe(1);
      }
      // Once they are gone, a later start finds none and says nothing.
      warn.mockClear();
      migrateControlDb(db);
      expect(warn).not.toHaveBeenCalled();
      expect(count(db, "alert_rules", "id", "api")).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });
});
