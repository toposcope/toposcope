import { describe, expect, test } from "bun:test";
import { judgeAcrossGap, mergeFingerprintCutSides } from "./fingerprint-cut";

const side = (hex: string, from: Record<string, number>) => ({
  hex,
  n: Object.values(from).reduce((a, b) => a + b, 0),
  from,
});

describe("judging across a gap with floors (#141)", () => {
  test("5j: prod-eu silent across both sides — a line only it fed reads 131 → ? and is can't tell, never stopped", () => {
    const merged = mergeFingerprintCutSides(
      [side("upstream", { "prod-us": 300, "prod-eu": 118 }), side("cache", { "prod-us": 88 }), side("payment", { "prod-eu": 131 })],
      [side("panic", { "prod-us": 171 }), side("upstream", { "prod-us": 233 })],
    );
    const sets = judgeAcrossGap(merged, { before: new Set(["prod-eu"]), after: new Set(["prod-eu"]) });
    expect(sets.firstSeen.map((r) => r.hex)).toEqual(["panic"]);
    expect(sets.stillHere.map((r) => [r.hex, r.before, r.after, r.floorBefore, r.floorAfter, r.held])).toEqual([
      ["upstream", 418, 233, true, true, "partly from prod-eu — both sides short"],
    ]);
    expect(sets.stopped.map((r) => [r.hex, r.cantTell ?? false])).toEqual([
      ["cache", false],
      ["payment", true],
    ]);
    const payment = sets.stopped.find((r) => r.hex === "payment")!;
    expect([payment.unknownAfter, payment.floorBefore, payment.held]).toEqual([true, undefined, "only from prod-eu — both sides short, can't tell"]);
  });

  test("5n: a hole in checkout-eu on the before side — a line only it fed reads ? → 64, never first seen", () => {
    const merged = mergeFingerprintCutSides(
      [side("payment", { "checkout-eu": 120, "prod-eu": 181 })],
      [side("adyen", { "prod-eu": 212 }), side("refund", { "checkout-eu": 64 }), side("payment", { "checkout-eu": 200, "prod-eu": 155 })],
    );
    const sets = judgeAcrossGap(merged, { before: new Set(["checkout-eu"]), after: new Set() });
    expect(sets.firstSeen.map((r) => [r.hex, r.cantTell ?? false])).toEqual([
      ["adyen", false],
      ["refund", true],
    ]);
    const refund = sets.firstSeen.find((r) => r.hex === "refund")!;
    expect([refund.unknownBefore, refund.held]).toEqual([true, "only from checkout-eu — before side short, can't tell"]);
    expect(sets.stillHere.map((r) => [r.hex, r.floorBefore, r.floorAfter, r.held])).toEqual([
      ["payment", true, false, "partly from checkout-eu — before side short"],
    ]);
    expect(sets.stopped).toEqual([]);
  });

  test("a row that is here proves the line: seen from the short source after, it is still here, not stopped", () => {
    const merged = mergeFingerprintCutSides([side("x", { "prod-us": 40 })], [side("x", { "prod-eu": 9 })]);
    const sets = judgeAcrossGap(merged, { before: new Set(["prod-eu"]), after: new Set(["prod-eu"]) });
    expect(sets.stillHere.map((r) => [r.hex, r.held, r.floorAfter])).toEqual([["x", "partly from prod-eu — both sides short", true]]);
    expect(sets.stopped).toEqual([]);
  });

  test("short only before, a line it fed only after is not first seen; one it fed only before, with the after side whole, really stopped", () => {
    const merged = mergeFingerprintCutSides([side("gone", { edge: 5 })], [side("new", { edge: 7 })]);
    const sets = judgeAcrossGap(merged, { before: new Set(["edge"]), after: new Set() });
    expect(sets.firstSeen.map((r) => [r.hex, r.cantTell])).toEqual([["new", true]]);
    expect(sets.stopped.map((r) => [r.hex, r.cantTell ?? false])).toEqual([["gone", false]]);
  });
});
