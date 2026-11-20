import { describe, expect, test } from "bun:test";
import { goneAfterMs, goneHunts, queryHosts } from "./gone-hosts";

const now = Date.parse("2026-11-20T20:00:00Z");
const day = 24 * 60 * 60_000;

describe("gone hosts (sheet 51b)", () => {
  test("a query's hosts", () => {
    expect(queryHosts("host:aws-03 event:disk")).toEqual(["aws-03"]);
    expect(queryHosts("host:aws-03 OR host:aws-02")).toEqual(["aws-03", "aws-02"]);
    expect(queryHosts("host:aws-03 NOT level:debug")).toEqual(["aws-03"]);
    expect(queryHosts("host:aws-03 OR service:api")).toEqual([]);
    expect(queryHosts("host:aws-*")).toEqual([]);
    expect(queryHosts("NOT host:aws-03")).toEqual([]);
    expect(queryHosts("service:api")).toEqual([]);
    expect(queryHosts("host:(")).toEqual([]);
  });

  test("a hunt is gone when every host it names is gone", () => {
    const lastSeen = new Map([
      ["aws-03", now - 18 * day],
      ["mev-01", now - 60_000],
      ["lat-01", now - goneAfterMs],
    ]);
    const saved = [
      { id: "a", query: "host:aws-03" },
      { id: "b", query: "host:mev-01" },
      { id: "c", query: "host:aws-03 OR host:mev-01" },
      { id: "d", query: "host:lat-01" },
      { id: "e", query: "host:azure-01" },
      { id: "f", query: "service:api" },
    ];
    const out = goneHunts(saved, lastSeen, now);
    expect(out.saved_ids).toEqual(["a", "d", "e"]);
    expect(out.hosts.map((h) => h.host)).toEqual(["azure-01", "aws-03", "lat-01"]);
    expect(out.hosts[0]!.last_seen).toBeNull();
    expect(out.hosts.map((h) => h.hunts)).toEqual([1, 1, 1]);
    expect(out.hosts[1]!.last_seen).toBe(new Date(now - 18 * day).toISOString());
  });
});
