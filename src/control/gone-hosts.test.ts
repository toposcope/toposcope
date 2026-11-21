import { describe, expect, test } from "bun:test";
import { goneAfterMs, goneHunts, queryHosts } from "./gone-hosts";

const now = Date.parse("2026-11-20T20:00:00Z");
const day = 24 * 60 * 60_000;

describe("gone hosts (sheet 51b)", () => {
  test("a query's hosts", () => {
    expect(queryHosts("host:node-a3 event:disk")).toEqual(["node-a3"]);
    expect(queryHosts("host:node-a3 OR host:node-a2")).toEqual(["node-a3", "node-a2"]);
    expect(queryHosts("host:node-a3 NOT level:debug")).toEqual(["node-a3"]);
    expect(queryHosts("host:node-a3 OR service:api")).toEqual([]);
    expect(queryHosts("host:aws-*")).toEqual([]);
    expect(queryHosts("NOT host:node-a3")).toEqual([]);
    expect(queryHosts("service:api")).toEqual([]);
    expect(queryHosts("host:(")).toEqual([]);
  });

  test("a hunt is gone when every host it names is gone", () => {
    const lastSeen = new Map([
      ["node-a3", now - 18 * day],
      ["node-1", now - 60_000],
      ["node-b1", now - goneAfterMs],
    ]);
    const saved = [
      { id: "a", query: "host:node-a3" },
      { id: "b", query: "host:node-1" },
      { id: "c", query: "host:node-a3 OR host:node-1" },
      { id: "d", query: "host:node-b1" },
      { id: "e", query: "host:node-d1" },
      { id: "f", query: "service:api" },
    ];
    const out = goneHunts(saved, lastSeen, now);
    expect(out.saved_ids).toEqual(["a", "d", "e"]);
    expect(out.hosts.map((h) => h.host)).toEqual(["node-d1", "node-a3", "node-b1"]);
    expect(out.hosts[0]!.last_seen).toBeNull();
    expect(out.hosts.map((h) => h.hunts)).toEqual([1, 1, 1]);
    expect(out.hosts[1]!.last_seen).toBe(new Date(now - 18 * day).toISOString());
  });
});
