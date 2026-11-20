import { describe, expect, test } from "bun:test";
import { otherValuesLabel, otherValuesLines } from "./other-values";

describe("other values on no matches (sheet 48)", () => {
  test("48d: the level the query names is left out, the others keep their counts", () => {
    const lines = otherValuesLines({ level: ["error"] }, { level: [{ v: "info", n: 2220 }, { v: "warn", n: 945 }, { v: "error", n: 0 }] });
    expect(lines).toEqual([{ field: "level", label: "Other levels", values: [{ v: "info", n: 2220 }, { v: "warn", n: 945 }] }]);
  });
  test("48e: one line per named field; a field with nothing else counted is dropped", () => {
    const lines = otherValuesLines(
      { level: ["warn"], service: ["billing"], host: ["app-9"] },
      { level: [{ v: "info", n: 340 }], service: [{ v: "api", n: 812 }, { v: "Billing", n: 3 }], host: [] },
    );
    expect(lines.map((l) => [l.label, l.values.map((v) => v.v)])).toEqual([
      ["Other levels", ["info"]],
      ["Other services", ["api"]],
    ]);
  });
  test("48f: text alone names no field, so there is nothing to switch to", () => {
    expect(otherValuesLines({}, { level: [{ v: "info", n: 1 }] })).toEqual([]);
  });
  test("caps a line and names attr fields plainly", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ v: `v${i}`, n: 9 - i }));
    expect(otherValuesLines({ region: "eu" }, { region: many })[0]?.values).toHaveLength(6);
    expect(otherValuesLabel("region")).toBe("Other region values");
  });
});
