import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUpgrader, requestUpgrade, upgradeDir } from "./upgrader";

// #220: the app asks the host to upgrade by writing one file into its own volume, and reads back how it went.
let dir: string;
const now = Date.parse("2026-10-24T14:02:00Z");
const at = (iso: string) => ({ dir, now: () => Date.parse(iso) });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "toposcope-upgrade-dir-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const enable = () => writeFileSync(join(dir, "enabled"), '{"enabled_at":"2026-10-24T10:00:00Z"}\n');

describe("where the app and the host meet", () => {
  test("beside the SQLite file, in the app's own volume", () => {
    expect(upgradeDir({ SQLITE_PATH: "/data/toposcope.sqlite" })).toBe("/data/upgrade");
    expect(upgradeDir({})).toBe("data/upgrade");
    expect(upgradeDir({ TOPOSCOPE_UPGRADE_DIR: "/elsewhere" })).toBe("/elsewhere");
  });
});

describe("asking for an upgrade", () => {
  test("off until the host ran enable-ui: 404, and nothing written", () => {
    const a = requestUpgrade("0.6.3", ["0.6.3"], { dir, now: () => now });
    expect(a.status).toBe(404);
    expect(a.body.error).toContain("./upgrade.sh enable-ui");
    expect(existsSync(join(dir, "request.json"))).toBe(false);
    expect(readUpgrader({ dir, now: () => now }).enabled).toBe(false);
  });

  test("only a release the check knows as newer", () => {
    enable();
    for (const v of ["0.6.2", "latest", "0.6.3; rm -rf /", 63, null]) {
      expect(requestUpgrade(v, ["0.6.3"], { dir, now: () => now }).status).toBe(400);
    }
    expect(existsSync(join(dir, "request.json"))).toBe(false);
  });

  test("writes the request whole, and says it is waiting", () => {
    enable();
    const a = requestUpgrade("0.6.3", ["0.6.4", "0.6.3"], { dir, now: () => now });
    expect(a.status).toBe(202);
    expect(JSON.parse(readFileSync(join(dir, "request.json"), "utf8"))).toEqual({ version: "0.6.3", requested_at: "2026-10-24T14:02:00.000Z" });
    expect(existsSync(join(dir, ".request.json.new"))).toBe(false);
    expect(a.body.upgrader?.requested).toEqual({ version: "0.6.3", requested_at: "2026-10-24T14:02:00.000Z" });
  });

  test("one at a time: a waiting request or a running upgrade is 409", () => {
    enable();
    expect(requestUpgrade("0.6.3", ["0.6.3"], { dir, now: () => now }).status).toBe(202);
    expect(requestUpgrade("0.6.3", ["0.6.3"], { dir, now: () => now }).status).toBe(409);
    rmSync(join(dir, "request.json"));
    writeFileSync(join(dir, "status.json"), JSON.stringify({ state: "running", to: "0.6.3", from: "0.6.2", started_at: "2026-10-24T14:02:05Z" }));
    expect(requestUpgrade("0.6.3", ["0.6.3"], at("2026-10-24T14:03:00Z")).status).toBe(409);
  });

  test("a request nobody took in 2 minutes is dropped, so it cannot start an upgrade later", () => {
    enable();
    requestUpgrade("0.6.3", ["0.6.3"], { dir, now: () => now });
    expect(readUpgrader(at("2026-10-24T14:03:59Z")).requested).not.toBeNull();
    expect(readUpgrader(at("2026-10-24T14:04:01Z")).requested).toBeNull();
    expect(existsSync(join(dir, "request.json"))).toBe(false);
  });
});

describe("how it went", () => {
  test("the host's status and the last lines of its log", () => {
    enable();
    const status = { state: "done", to: "0.6.3", from: "0.6.2", started_at: "2026-10-24T14:02:05Z", finished_at: "2026-10-24T14:02:46Z", backup: "/opt/toposcope/backups/20261024T140210Z-0.6.2", message: null };
    writeFileSync(join(dir, "status.json"), JSON.stringify(status));
    writeFileSync(join(dir, "last.log"), Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") + "\n\n");
    const u = readUpgrader({ dir, now: () => now });
    expect(u.status).toEqual(status as never);
    expect(u.log).toEqual(["line 5", "line 6", "line 7", "line 8", "line 9", "line 10", "line 11", "line 12"]);
  });

  test("a run that went quiet for two hours is over, not running forever", () => {
    writeFileSync(join(dir, "status.json"), JSON.stringify({ state: "running", to: "0.6.3", from: "0.6.2", started_at: "2026-10-24T10:00:00Z" }));
    const old = Date.parse("2026-10-24T10:00:00Z") / 1000;
    utimesSync(join(dir, "status.json"), old, old);
    const u = readUpgrader({ dir, now: () => now });
    expect(u.status?.state).toBe("failed");
    expect(u.status?.message).toBe("The host stopped saying how the upgrade went.");
  });

  test("a status it cannot read is no status", () => {
    writeFileSync(join(dir, "status.json"), "{not json");
    expect(readUpgrader({ dir, now: () => now }).status).toBeNull();
    writeFileSync(join(dir, "status.json"), JSON.stringify({ state: "exploded" }));
    expect(readUpgrader({ dir, now: () => now }).status).toBeNull();
  });
});
