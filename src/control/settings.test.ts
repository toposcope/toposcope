import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  effectiveMetricsRetentionDays,
  getMetricsRetentionDays,
  getRetentionDays,
  getRetentionRules,
  longestRetentionDays,
  parseMetricsRetentionDays,
  parseRetentionRules,
  writeRetentionRules,
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

describe("services kept longer (#477)", () => {
  test("none by default; stored sorted; an empty list removes the row", () => {
    const db = memDb();
    expect(getRetentionRules(db)).toEqual([]);
    expect(longestRetentionDays(db)).toBe(30);
    writeRetentionRules([{ service: "billing", days: 90 }, { service: "analytics", days: 730 }], db);
    expect(getRetentionRules(db)).toEqual([
      { service: "analytics", days: 730 },
      { service: "billing", days: 90 },
    ]);
    expect(longestRetentionDays(db)).toBe(730);
    writeRetentionRules([], db);
    expect(db.query("SELECT count(*) AS n FROM settings WHERE key = 'retention_rules'").get()).toEqual({ n: 0 });
  });

  test("parse refuses what the card refuses", () => {
    expect(parseRetentionRules(null, 30)).toEqual([]);
    expect(parseRetentionRules([{ service: " analytics ", days: 730 }], 30)).toEqual([{ service: "analytics", days: 730 }]);
    expect(parseRetentionRules({}, 30)).toEqual({ error: "retention_rules is a list of { service, days }" });
    expect(parseRetentionRules([{ service: "", days: 90 }], 30)).toHaveProperty("error");
    expect(parseRetentionRules([{ service: "a\nb", days: 90 }], 30)).toHaveProperty("error");
    expect(parseRetentionRules([{ service: "x".repeat(129), days: 90 }], 30)).toHaveProperty("error");
    expect(parseRetentionRules([{ service: "a", days: 731 }], 30)).toEqual({ error: "a: 1–730 whole days" });
    expect(parseRetentionRules([{ service: "a", days: 1.5 }], 1)).toEqual({ error: "a: 1–730 whole days" });
    expect(parseRetentionRules([{ service: "a", days: 20 }], 30)).toEqual({ error: "a: 20 days is shorter than logs (30)" });
    expect(parseRetentionRules([{ service: "a", days: 90 }, { service: "a", days: 90 }], 30)).toEqual({ error: "a is listed twice" });
    expect(parseRetentionRules(Array.from({ length: 9 }, (_, i) => ({ service: `s${i}`, days: 90 })), 30)).toEqual({
      error: "At most 8 services are kept longer",
    });
  });
});
