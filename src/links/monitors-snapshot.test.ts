import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrateControlDb } from "../control/index";
import { keepMonitorsSnapshot, monitorsSnapshot, pulledMonitors } from "./monitors-snapshot";

function db(): Database {
  const d = new Database(":memory:");
  migrateControlDb(d);
  const add = (id: string, name: string, service: string, host: string) =>
    d.query(
      `INSERT INTO alert_rules (id, name, query, webhook_url, threshold, enabled, created_at, kind, source, state, service, host)
       VALUES (?, ?, '', '', 1, 1, 1, 'threshold', 'http', 'ok', ?, ?)`,
    ).run(id, name, service, host);
  add("m1", "api health", "api", "api.example.com");
  add("m2", "billing db", "billing", "billing-db");
  d.query(
    `INSERT INTO monitor_stretches (id, monitor_id, opened_at, resolved_at, open_message, last_at) VALUES ('s1', 'm2', ?, NULL, 'down', ?)`,
  ).run(Date.now() - 60_000, Date.now() - 60_000);
  return d;
}

describe("a source's monitors over a link (#333)", () => {
  test("an empty filter sends every monitor and its open stretch", () => {
    const snap = monitorsSnapshot("", "edge-1", Date.now(), db())!;
    expect(snap.monitors.map((m) => [m.name, m.service, m.host])).toEqual([
      ["api health", "api", "api.example.com"],
      ["billing db", "billing", "billing-db"],
    ].sort((a, b) => (a[0]! < b[0]! ? 1 : -1)).reverse());
    expect(snap.stretches.map((s) => [s.monitor_id, s.open_message, s.resolved_at])).toEqual([["m2", "down", null]]);
  });

  test("a filter on service or host sends only the monitors it lets through; one naming level sends none", () => {
    const d = db();
    expect(monitorsSnapshot("service:billing", "edge-1", Date.now(), d)!.monitors.map((m) => m.id)).toEqual(["m2"]);
    expect(monitorsSnapshot("host:api.example.com", "edge-1", Date.now(), d)!.stretches).toEqual([]);
    expect(monitorsSnapshot("toposcope:elsewhere", "edge-1", Date.now(), d)!.monitors).toEqual([]);
    expect(monitorsSnapshot("level:error", "edge-1", Date.now(), d)).toBeNull();
  });

  test("the puller keeps the newest snapshot of each source", () => {
    const d = db();
    keepMonitorsSnapshot("edge-1", { monitors: [], stretches: [] }, 1, d);
    keepMonitorsSnapshot("edge-1", monitorsSnapshot("", "edge-1", Date.now(), db())!, 2, d);
    const kept = pulledMonitors(d);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ source: "edge-1", at: 2 });
    expect(kept[0]!.monitors).toHaveLength(2);
  });

  test("a region forwards the edge's monitors under the edge's name, and nothing comes back home (#334)", () => {
    const region = db();
    keepMonitorsSnapshot("edge-1", monitorsSnapshot("", "edge-1", Date.now(), db())!, 1, region);
    const sent = monitorsSnapshot("", "region-eu", Date.now(), region)!;
    expect(sent.forwarded?.map((f) => [f.source, f.monitors.length])).toEqual([["edge-1", 2]]);
    const centre = db();
    keepMonitorsSnapshot("region-eu", sent, 2, centre, "prod-eu");
    expect(pulledMonitors(centre).map((p) => p.source).sort()).toEqual(["edge-1", "region-eu"]);
    // Back at the instance the monitors entered: not kept as another's.
    const edge = db();
    keepMonitorsSnapshot("region-eu", sent, 3, edge, "edge-1");
    expect(pulledMonitors(edge).map((p) => p.source)).toEqual(["region-eu"]);
  });
});
