import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { LogEvent } from "../shared/log-event";
import { runReleaseCheck, type Release } from "./release-check";
import { announceNewRelease, lastAnnounced, updateRow } from "./update-event";

// #197: one event:update_available row per new version, to page on with an ordinary monitor.
function memDb(): Database {
  const db = new Database(":memory:");
  db.run("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  return db;
}

const release = (version: string): Release => ({
  version,
  published_at: "2026-10-21T09:00:00Z",
  url: `https://github.com/toposcope/toposcope/releases/tag/v${version}`,
  notes: "",
  before_you_upgrade: null,
});

describe("the update_available row", () => {
  test("names the newest release, the step, and how many lie between", () => {
    const row = updateRow([release("0.6.1"), release("0.6.0"), release("0.5.7")], "0.5.6", null, Date.parse("2026-10-21T10:00:00Z"));
    expect(row).toEqual({
      ts: "2026-10-21T10:00:00.000Z",
      service: "toposcope",
      level: "info",
      message: "Toposcope 0.6.1 is out; this instance runs 0.5.6 (minor)",
      attrs: {
        event: "update_available",
        running: "0.5.6",
        latest: "0.6.1",
        step: "minor",
        behind: 3,
        url: "https://github.com/toposcope/toposcope/releases/tag/v0.6.1",
      },
    });
  });

  test("once per version: a restart writes none, a newer release writes one more", async () => {
    const db = memDb();
    const written: LogEvent[] = [];
    const deps = { db, write: async (rows: LogEvent[]) => void written.push(...rows) };
    expect(await announceNewRelease([release("0.6.1")], "0.6.0", deps)).toBe(true);
    expect(await announceNewRelease([release("0.6.1")], "0.6.0", deps)).toBe(false);
    expect(await announceNewRelease([release("0.6.2"), release("0.6.1")], "0.6.0", deps)).toBe(true);
    expect(written.map((r) => r.attrs!.latest)).toEqual(["0.6.1", "0.6.2"]);
    expect(lastAnnounced(db)).toBe("0.6.2");
  });

  test("nothing newer, or a fresh install of the latest, writes nothing", async () => {
    const db = memDb();
    const written: LogEvent[] = [];
    expect(await announceNewRelease([], "0.6.1", { db, write: async (rows) => void written.push(...rows) })).toBe(false);
    expect(written).toEqual([]);
  });

  test("a row that could not be stored is tried again on the next check", async () => {
    const db = memDb();
    await expect(
      announceNewRelease([release("0.6.1")], "0.6.0", { db, write: async () => { throw new Error("ClickHouse down"); } }),
    ).rejects.toThrow("ClickHouse down");
    expect(lastAnnounced(db)).toBeNull();
    const written: LogEvent[] = [];
    expect(await announceNewRelease([release("0.6.1")], "0.6.0", { db, write: async (rows) => void written.push(...rows) })).toBe(true);
    expect(written).toHaveLength(1);
  });

  test("a failed check writes no row, so an air-gapped install never pages", async () => {
    const db = memDb();
    const written: LogEvent[] = [];
    await runReleaseCheck({
      db,
      running: "0.6.0",
      fetch: (async () => { throw new Error("Unable to connect"); }) as unknown as typeof fetch,
      onChecked: (releases, running) => announceNewRelease(releases, running, { db, write: async (rows) => void written.push(...rows) }),
    });
    expect(written).toEqual([]);
  });
});
