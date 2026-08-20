import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LINK_CAP } from "../shared/fields";
import { readFieldConfig, storedSkipKeys, writeFieldConfig } from "./fields";

function memDb(): Database {
  const db = new Database(":memory:");
  db.run(`
    CREATE TABLE field_roles (
      key TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK (role IN ('chart', 'lookup', 'ignore'))
    );
  `);
  db.run(`
    CREATE TABLE field_links (
      log_key TEXT PRIMARY KEY,
      metric_label TEXT NOT NULL
    );
  `);
  return db;
}

describe("field config store", () => {
  test("round-trips roles and links and lists skip keys", () => {
    const db = memDb();
    writeFieldConfig(
      { request_id: "lookup", noise: "ignore" },
      { system: "source", host: "instance" },
      db,
    );
    expect(readFieldConfig(db)).toEqual({
      roles: { request_id: "lookup", noise: "ignore" },
      links: { system: "source", host: "instance" },
    });
    expect(storedSkipKeys(db)).toEqual(["noise", "request_id"]);
  });

  test("replace clears previous rows and keeps the cap", () => {
    const db = memDb();
    const links: Record<string, string> = {};
    for (let i = 0; i < LINK_CAP; i++) {
      links[`k${i}`] = "source";
    }
    writeFieldConfig({ request_id: "lookup" }, links, db);
    expect(Object.keys(readFieldConfig(db).links)).toHaveLength(LINK_CAP);
    writeFieldConfig({}, { system: "source" }, db);
    expect(readFieldConfig(db)).toEqual({
      roles: {},
      links: { system: "source" },
    });
  });
});
