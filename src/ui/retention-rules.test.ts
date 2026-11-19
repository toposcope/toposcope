import { describe, expect, test } from "bun:test";
import { draftsOf, longestKeptDays, ruleFault, rulesOf, shortened, shortenedLine } from "./retention-rules";

describe("Kept longer (#477, sheet 46)", () => {
  test("a window may reach back as far as the longest kept service", () => {
    expect(longestKeptDays({ retention_days: 30 })).toBe(30);
    expect(longestKeptDays({ retention_days: 30, retention_rules: [{ days: 90 }, { days: 730 }] })).toBe(730);
  });

  test("46f: days out of range or shorter than logs", () => {
    expect(ruleFault([{ service: "analytics", days: "730" }], 30)).toBeNull();
    expect(ruleFault([{ service: "analytics", days: "900" }], 30)).toEqual({
      service: "analytics",
      message: "1–730 days, and not shorter than logs (30)",
    });
    expect(ruleFault([{ service: "a", days: "20" }], 30)?.service).toBe("a");
    expect(ruleFault([{ service: "a", days: "" }], 30)?.service).toBe("a");
    expect(ruleFault([{ service: "a", days: "1.5" }], 1)?.service).toBe("a");
  });

  test("46e: removing or lowering a kept service is what a save deletes", () => {
    const before = [
      { service: "analytics", days: 730 },
      { service: "billing", days: 90 },
    ];
    expect(shortened(before, before, 30)).toEqual([]);
    expect(shortened(before, [{ service: "analytics", days: 730 }], 30)).toEqual([{ service: "billing", days: 30 }]);
    expect(shortened(before, [{ service: "analytics", days: 400 }, { service: "billing", days: 120 }], 30)).toEqual([
      { service: "analytics", days: 400 },
    ]);
    expect(shortened([], [{ service: "a", days: 90 }], 30)).toEqual([]);
  });

  test("46e's line", () => {
    expect(shortenedLine([{ service: "billing", days: 30 }])).toBe(
      "goes back to 30 days. Its rows older than 30 days are deleted at the next sweep.",
    );
  });

  test("drafts round-trip", () => {
    const rules = [{ service: "analytics", days: 730 }];
    expect(rulesOf(draftsOf(rules))).toEqual(rules);
    expect(draftsOf(null)).toEqual([]);
  });
});
