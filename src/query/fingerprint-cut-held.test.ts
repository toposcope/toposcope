import { afterEach, describe, expect, test } from "bun:test";
import type { HeldLink } from "../shared/held";
import { compileQuery } from "./compile";
import { cutGapNotes, fingerprintCutFirstSeen, fingerprintCutHeld, firstSeenScans, shortAcrossCut } from "./fingerprint-cut";

const now = Date.parse("2026-08-14T15:00:00Z");
const at = (t: string) => Date.parse(`2026-08-14T${t}Z`);
const windows = { beforeFrom: at("13:22:08"), beforeTo: at("14:11:04"), afterFrom: at("14:11:04"), afterTo: now };

function link(over: Partial<HeldLink> = {}): HeldLink {
  return {
    role: "pull",
    connects: "we",
    peer_name: "prod-eu",
    q: "",
    position: 100,
    settled: 100,
    arrived_at: "2026-08-14T14:59:58Z",
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

const original = fingerprintCutHeld.links;
afterEach(() => {
  fingerprintCutHeld.links = original;
});

describe("which sources are short across a cut (#140, #141)", () => {
  test("a source not answering since mid-window: refused, naming the source and the side", () => {
    fingerprintCutHeld.links = () => [link({ last_contact_at: at("14:02:17"), last_error: "timeout" }), link({ peer_name: "prod-us" })];
    const held = shortAcrossCut(compileQuery("level:error").ast, windows, now);
    expect(held?.sides).toBe("both");
    expect(held?.sources.map((s) => s.name)).toEqual(["prod-eu"]);
  });

  test("short only after the cut: the after side misses rows", () => {
    fingerprintCutHeld.links = () => [link({ position: 90, arrived_at: "2026-08-14T14:56:02Z" })];
    expect(shortAcrossCut(null, windows, now)?.sides).toBe("after");
  });

  test("caught up, or a hunt that names other sources (5r): not refused", () => {
    fingerprintCutHeld.links = () => [link()];
    expect(shortAcrossCut(null, windows, now)).toBeNull();
    fingerprintCutHeld.links = () => [link({ last_contact_at: at("14:02:17"), last_error: "timeout" }), link({ peer_name: "prod-us" })];
    expect(shortAcrossCut(compileQuery("toposcope:prod-us level:error").ast, windows, now)).toBeNull();
  });

  test("a hole never clears: a cut whose window touches one keeps refusing", () => {
    fingerprintCutHeld.links = () => [link({ gone_from: 1, gone_to: 9, gone_from_at: "2026-08-14T13:30:00Z", gone_to_at: "2026-08-14T13:40:00Z" })];
    expect(shortAcrossCut(null, windows, now)?.sides).toBe("before");
    expect(shortAcrossCut(null, { ...windows, beforeFrom: at("14:00:00") }, now)).toBeNull();
  });

  test("the head note says where the source stands, which side misses its rows, and that its lines read ?", () => {
    fingerprintCutHeld.links = () => [link({ last_contact_at: at("14:02:17"), last_error: "timeout" })];
    const held = shortAcrossCut(null, windows, now)!;
    const w = { ...windows, beforeMs: 49 * 60_000 - 4_000, sideMs: 49 * 60_000 - 4_000 };
    expect(cutGapNotes(held, w, now)).toEqual([
      "prod-eu not answering since 14:02:17 — both sides miss its rows. A line seen only from prod-eu reads ?, not stopped or first seen.",
    ]);
    fingerprintCutHeld.links = () => [link({ gone_from: 1, gone_to: 9, gone_from_at: "2026-08-14T13:00:00Z", gone_to_at: "2026-08-14T13:42:08Z" })];
    const hole = shortAcrossCut(null, windows, now)!;
    expect(cutGapNotes(hole, { ...w, beforeMs: 49 * 60_000 - 4_000 }, now)[0]).toBe(
      "Hole in prod-eu until 08-14 13:42 — the before side misses 20m of its 48m 56s from it. A line seen only from prod-eu reads ?, not first seen.",
    );
  });

  test("a new-fingerprints alert pages only what it can tell is new: never a line only the short source fed", async () => {
    fingerprintCutHeld.links = () => [link({ last_contact_at: at("14:02:17"), last_error: "timeout" })];
    const counts = firstSeenScans.counts;
    const asked: boolean[] = [];
    firstSeenScans.counts = async (from, _to, _compiled, bySource) => {
      asked.push(Boolean(bySource));
      const rows: Array<{ hex: string; n: number; from: Record<string, number> }> = from < "2026-08-14T14:11"
        ? [{ hex: "old", n: 5, from: { "prod-us": 5 } }]
        : [
            { hex: "panic", n: 171, from: { "prod-us": 171 } },
            { hex: "late", n: 4, from: { "prod-eu": 4 } },
          ];
      return rows;
    };
    try {
      const result = await fingerprintCutFirstSeen({
        mark: { id: "deploy-worker-v1.4.3", ts: "2026-08-14T14:11:04.221Z", end_ts: null, kind: "deploy", service: "worker", title: "v1.4.3", attrs: {} },
        compiled: compileQuery("level:error"),
        now,
      });
      expect(asked).toEqual([true, true]);
      expect(result.refused).toBeNull();
      expect(result.firstSeen.map((r) => r.hex)).toEqual(["panic"]);
    } finally {
      firstSeenScans.counts = counts;
    }
  });
});
