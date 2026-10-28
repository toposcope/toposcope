import { describe, expect, test } from "bun:test";
import type { HeldLink } from "../shared/held";
import { behindMs, parseUpstream, upstreamFor } from "./upstream";

const now = Date.parse("2026-10-28T15:00:00Z");

function link(over: Partial<HeldLink> = {}): HeldLink {
  return {
    role: "pull",
    connects: "we",
    peer_name: "edge-fra",
    q: "",
    position: 50,
    settled: 90,
    arrived_at: new Date(now - 240_000).toISOString(),
    last_contact_at: now - 2_000,
    last_error: null,
    created_at: now - 86_400_000,
    gone_from: null,
    gone_to: null,
    gone_from_at: null,
    gone_to_at: null,
    ...over,
  };
}

describe("what a source tells its puller of its own sources (#334)", () => {
  test("each source as its Search reads it, never the puller itself, never one the filter rules out by toposcope", () => {
    const links = [link(), link({ peer_name: "prod-eu", position: 9, settled: 9 }), link({ peer_name: "edge-ams", position: 9, settled: 9 })];
    const told = upstreamFor({ q: "", peer_name: "prod-eu" }, now, links);
    expect(told.map((s) => [s.name, s.state.kind])).toEqual([
      ["edge-fra", "behind"],
      ["edge-ams", "caught-up"],
    ]);
    expect(upstreamFor({ q: "toposcope:edge-ams", peer_name: "prod-eu" }, now, links).map((s) => s.name)).toEqual(["edge-ams"]);
  });

  test("what came from further away goes on, without saying which link it came through here", () => {
    const edge = { name: "edge-fra", filters: [], state: { kind: "behind" as const, readTo: now - 600_000 }, hole: null };
    const told = upstreamFor({ q: "", peer_name: "prod-eu" }, now, [link({ peer_name: "region-eu", position: 9, settled: 9, upstream: [edge] })]);
    expect(told).toEqual([
      { name: "region-eu", filters: [], state: { kind: "caught-up" }, hole: null },
      { name: "edge-fra", filters: [], state: { kind: "behind", readTo: now - 600_000 }, hole: null },
    ]);
  });

  test("what another instance said is kept only where it reads as sources", () => {
    expect(parseUpstream("not json")).toEqual([]);
    expect(parseUpstream({ name: "x" })).toEqual([]);
    expect(
      parseUpstream(
        JSON.stringify([
          { name: "edge-fra", filters: ["level:error", 3], state: { kind: "quiet", since: 5, knownTo: 4, connects: "they" }, hole: { from: 1, to: 2 } },
          { name: "", filters: [], state: { kind: "caught-up" } },
          { name: "edge-ams", filters: [], state: { kind: "behind" } },
        ]),
      ),
    ).toEqual([{ name: "edge-fra", filters: ["level:error"], state: { kind: "quiet", since: 5, knownTo: 4, connects: "they" }, hole: { from: 1, to: 2 } }]);
  });

  test("how far behind, in time", () => {
    expect(behindMs({ kind: "caught-up" }, now)).toBe(0);
    expect(behindMs({ kind: "behind", readTo: now - 240_000 }, now)).toBe(240_000);
    expect(behindMs({ kind: "quiet", since: now - 60_000, knownTo: now - 90_000, connects: "we" }, now)).toBe(90_000);
  });
});
