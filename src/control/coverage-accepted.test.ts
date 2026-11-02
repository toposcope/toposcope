import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { acceptGap, readAccepted, undoGap } from "./coverage-accepted";

function memDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE coverage_accepted (service TEXT NOT NULL, key TEXT NOT NULL, share REAL NOT NULL, by_id TEXT, by_name TEXT, at INTEGER NOT NULL, PRIMARY KEY (service, key))`);
  db.run(`CREATE TABLE coverage_accepted_log (service TEXT NOT NULL, key TEXT NOT NULL, action TEXT NOT NULL, share REAL, by_id TEXT, by_name TEXT, at INTEGER NOT NULL)`);
  return db;
}

describe("accepted coverage gaps (#392)", () => {
  test("accept keeps the share at accept; undo removes it; both are logged with when", () => {
    const db = memDb();
    acceptGap("auth", "trace_id", 0.12, 1000, db);
    expect(readAccepted(db)).toEqual([{ service: "auth", key: "trace_id", share: 0.12, by: null, at: 1000 }]);
    expect(undoGap("auth", "trace_id", 2000, db)).toBe(true);
    expect(undoGap("auth", "trace_id", 3000, db)).toBe(false);
    expect(readAccepted(db)).toEqual([]);
    const log = db.query("SELECT action, at FROM coverage_accepted_log ORDER BY at").all();
    expect(log).toEqual([
      { action: "accept", at: 1000 },
      { action: "undo", at: 2000 },
    ]);
  });
});
