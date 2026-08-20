import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { getRetentionDays, writeRetentionDays } from "./settings";

function memDb(): Database {
  const db = new Database(":memory:");
  db.run(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

describe("retention settings store", () => {
  test("write persists before any ClickHouse ALTER", () => {
    const db = memDb();
    expect(writeRetentionDays(365, db)).toBe(365);
    expect(getRetentionDays(db)).toBe(365);
    expect(writeRetentionDays(400, db)).toBe(365);
    expect(getRetentionDays(db)).toBe(365);
  });
});
