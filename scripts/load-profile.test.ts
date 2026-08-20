import { describe, expect, test } from "bun:test";
import { parseLoadProfile } from "./load-profile";

describe("parseLoadProfile", () => {
  test("pairs volume with window", () => {
    expect(parseLoadProfile("10k")).toMatchObject({ n: 10_000, range: "1h" });
    expect(parseLoadProfile("500k")).toMatchObject({ n: 500_000, range: "24h" });
    expect(parseLoadProfile("10m")).toMatchObject({ n: 10_000_000, range: "7d" });
    expect(parseLoadProfile("100m")).toMatchObject({
      n: 100_000_000,
      range: "7d",
      via: "clickhouse",
    });
  });

  test("defaults to 10k/1h", () => {
    expect(parseLoadProfile(undefined).id).toBe("10k");
  });

  test("rejects unknown names", () => {
    expect(() => parseLoadProfile("1b")).toThrow(/10k, 500k, 10m, or 100m/);
  });
});
