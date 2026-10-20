import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { announceNewRelease } from "../control/update-event";
import { insertEvents } from "../ingest/index";
import { pingClickHouse } from "../shared/clickhouse";
import { migrateStore } from "../shared/migrate";
import { searchRoute } from "./index";

process.env.CLICKHOUSE_USER ??= "default";
process.env.CLICKHOUSE_PASSWORD ??= "toposcope";
process.env.CLICKHOUSE_URL ??= "http://127.0.0.1:8123";

// #197: the row a new release writes is an ordinary row, found by the search a monitor reads.
const run = Date.now();
const latest = `9.${run % 1000}.${run % 997}`;
const app = new Hono();
app.get("/api/search", searchRoute);

let ready = false;
beforeAll(async () => {
  ready = await pingClickHouse();
  if (ready) await migrateStore();
});

describe("a new release's row in search", () => {
  test("service:toposcope event:update_available finds it, with the step and the newest version", async () => {
    if (!ready) return;
    const db = new Database(":memory:");
    db.run("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const release = { version: latest, published_at: null, url: null, notes: "", before_you_upgrade: null };
    expect(await announceNewRelease([release], "0.6.0", { db, write: insertEvents })).toBe(true);
    const q = encodeURIComponent(`service:toposcope event:update_available latest:${latest}`);
    const res = await app.request(`/api/search?q=${q}&range=15m`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<{ message: string; attrs: Record<string, unknown> }> };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]!.message).toBe(`Toposcope ${latest} is out; this instance runs 0.6.0 (major)`);
    expect(body.events[0]!.attrs.step).toBe("major");
  });
});
