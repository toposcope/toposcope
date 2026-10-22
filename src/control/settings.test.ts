import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  effectiveMetricsRetentionDays,
  getMetricsRetentionDays,
  getRetentionDays,
  parseMetricsRetentionDays,
  writeMetricsRetentionDays,
  writeRetentionDays,
} from "./settings";

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

describe("metrics retention store", () => {
  test("unset follows logs", () => {
    const db = memDb();
    expect(getMetricsRetentionDays(db)).toBeNull();
    expect(effectiveMetricsRetentionDays(db)).toBe(30);
    writeRetentionDays(14, db);
    expect(effectiveMetricsRetentionDays(db)).toBe(14);
  });

  test("its own days outlive logs, and null clears them", () => {
    const db = memDb();
    expect(writeMetricsRetentionDays(400, db)).toBe(400);
    expect(getMetricsRetentionDays(db)).toBe(400);
    expect(effectiveMetricsRetentionDays(db)).toBe(400);
    expect(getRetentionDays(db)).toBe(30);
    expect(writeMetricsRetentionDays(900, db)).toBe(730);
    expect(writeMetricsRetentionDays(null, db)).toBeNull();
    expect(effectiveMetricsRetentionDays(db)).toBe(30);
  });

  test("parse takes whole days in range, or null or empty for none", () => {
    expect(parseMetricsRetentionDays(400)).toBe(400);
    expect(parseMetricsRetentionDays(null)).toBeNull();
    expect(parseMetricsRetentionDays("")).toBeNull();
    for (const bad of [0, 731, 10.5, "400", true]) {
      expect(parseMetricsRetentionDays(bad)).toHaveProperty("error");
    }
  });
});
