import { describe, expect, test } from "bun:test";
import { eventTableMarkLayout } from "./change-marks";
import { heldView, savedWindow } from "./held-view";
import type { HeldSource } from "../shared/held";

const now = Date.parse("2026-08-14T15:00:00Z");
const at = (t: string) => Date.parse(`2026-08-14T${t}Z`);
const hour = { from: at("14:00:00"), to: now };
const src = (over: Partial<HeldSource> & { name: string }): HeldSource => ({ filters: [], state: { kind: "caught-up" }, hole: null, ...over });

function view(sources: HeldSource[], q = "", counts: Record<string, number> = {}, total = 0, window = hour) {
  return heldView({ sources, now, live: false, window, q, counts: new Map(Object.entries(counts)), total });
}

describe("what Search draws (#139)", () => {
  test("5a: nothing linked, nothing drawn", () => {
    expect(view([])).toBeNull();
  });

  test("5b: caught up and unfiltered, the count is plain", () => {
    const v = view([src({ name: "prod-eu" })], "", { "prod-eu": 311_000 }, 311_000)!;
    expect([v.floor, v.pill, v.chip, v.hatches, v.rows]).toEqual([false, null, null, [], []]);
  });

  test("5c: four minutes behind — a floor, a pill, a hatch to now, a row at the read position", () => {
    const v = view([src({ name: "prod-eu", state: { kind: "behind", readTo: at("14:56:02") } })])!;
    expect(v.floor).toBe(true);
    expect(v.pill).toBe("prod-eu 4m behind");
    expect(v.hatches).toEqual([{ source: "prod-eu", kind: "behind", from: at("14:56:02"), to: now, label: "not here yet" }]);
    expect(v.rows.map((r) => [r.at, r.text])).toEqual([[at("14:56:02"), "prod-eu read to 14:56:02 — its rows after this are not here yet"]]);
    expect(v.facetFloor("level", "error")).toBe(true);
  });

  test("5e: a hole draws only while the window overlaps it; its row sits at the far end", () => {
    const hole = src({ name: "prod-eu", hole: { from: Date.parse("2026-08-09T18:40:00Z"), to: Date.parse("2026-08-11T00:00:00Z") } });
    expect(view([hole])!.floor).toBe(false);
    const week = view([hole], "", {}, 0, { from: now - 7 * 86_400_000, to: now })!;
    expect(week.pill).toBe("prod-eu hole 08-09 18:40 → 08-11");
    expect(week.rows[0]?.at).toBe(Date.parse("2026-08-11T00:00:00Z"));
    expect(week.hatches[0]?.label).toBe("hole · gone at source");
  });

  test("5f and 5o: the scope chip, with a count only when part of the total came through the filter", () => {
    const billing = src({ name: "billing-app", filters: ["level:error"] });
    expect(view([billing], "service:billing", { "billing-app": 1240 }, 1240)!.chip).toEqual({
      count: null,
      filter: "level:error",
      from: "billing-app",
      filters: 1,
    });
    const mixed = view([src({ name: "prod-eu" }), src({ name: "prod-us" }), billing], "", { "prod-eu": 201_000, "prod-us": 108_000, "billing-app": 1960 }, 311_000)!;
    expect(mixed.chip).toEqual({ count: 1960, filter: "level:error", from: "billing-app", filters: 1 });
    // 5g: hunting level:error, the filter cuts nothing the hunt kept.
    expect(view([billing], "level:error", { "billing-app": 1960 }, 18_400)!.chip).toBeNull();
    // A filtered source with nothing in this hunt adds no chip.
    expect(view([billing], "", {}, 10)!.chip).toBeNull();
  });

  test("5r: the hunt names a caught-up source, so nothing is short — and the group still floors the short one", () => {
    const sources = [src({ name: "prod-eu", state: { kind: "behind", readTo: at("14:56:02") } }), src({ name: "prod-us" })];
    const v = view(sources, "toposcope:prod-us level:error")!;
    expect([v.floor, v.pill, v.rows.length, v.hatches.length]).toEqual([false, null, 0, 0]);
    expect(v.facetFloor("toposcope", "prod-eu")).toBe(true);
    expect(v.facetFloor("toposcope", "prod-us")).toBe(false);
    expect(v.facetFloor("level", "error")).toBe(false);
  });

  test("5g: two short sources, one pill naming both, one row each", () => {
    const v = view([
      src({ name: "site-0417", state: { kind: "quiet", since: at("14:20:31"), knownTo: at("14:20:31"), connects: "we" } }),
      src({ name: "prod-eu", state: { kind: "behind", readTo: at("14:56:02") } }),
      src({ name: "prod-us" }),
    ])!;
    expect(v.pill).toBe("2 short · site-0417 · prod-eu");
    // Each span says only whose it is, the quiet one too: tagL(33.3, 'site-0417'), tagR('prod-eu').
    expect(v.hatches.map((h) => h.label)).toEqual(["site-0417", "prod-eu"]);
    expect(v.rows).toHaveLength(2);
  });

  test("saved badges count their own query over their own span", () => {
    const v = view([src({ name: "prod-eu", state: { kind: "behind", readTo: at("14:56:02") } })])!;
    expect(v.countGaps("status:5*", savedWindow({ range: "1h", from_ts: null, to_ts: null }, now)!)).toHaveLength(1);
    expect(v.countGaps("toposcope:central service:ingest", { from: at("14:00:00"), to: now })).toEqual([]);
    expect(v.countGaps("", { from: at("12:00:00"), to: at("13:00:00") })).toEqual([]);
  });
});

describe("the hatched table row (#139)", () => {
  const events = [{ ts: "2026-08-14T14:59:52.104Z" }, { ts: "2026-08-14T14:59:45.741Z" }, { ts: "2026-08-14T14:55:58.310Z" }];
  const row = { at: at("14:56:02"), text: "prod-eu read to 14:56:02", key: "held:prod-eu:behind" };

  test("sits at the read position: newer rows from other sources above it", () => {
    const layout = eventTableMarkLayout(events, [], null, { rows: [row], complete: false });
    expect(layout.rows.map((r) => r.type)).toEqual(["event", "event", "held", "event"]);
  });

  test("with nothing newer it sits on top; older than the page, only once every row is loaded", () => {
    expect(eventTableMarkLayout(events, [], null, { rows: [{ ...row, at: at("15:00:00") }], complete: false }).rows[0]?.type).toBe("held");
    const old = { ...row, at: at("14:00:00") };
    expect(eventTableMarkLayout(events, [], null, { rows: [old], complete: false }).rows.some((r) => r.type === "held")).toBe(false);
    expect(eventTableMarkLayout(events, [], null, { rows: [old], complete: true }).rows.at(-1)?.type).toBe("held");
  });
});
