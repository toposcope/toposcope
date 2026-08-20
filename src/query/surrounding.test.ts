import { describe, expect, test } from "bun:test";
import {
  clampSurroundingN,
  surroundingDefaultN,
  surroundingMaxN,
  surroundingWhere,
} from "./surrounding";

describe("clampSurroundingN", () => {
  test("defaults to 50 and caps at 200", () => {
    expect(clampSurroundingN(undefined)).toBe(surroundingDefaultN);
    expect(clampSurroundingN(0)).toBe(1);
    expect(clampSurroundingN(500)).toBe(surroundingMaxN);
    expect(clampSurroundingN(25)).toBe(25);
  });
});

describe("surroundingWhere", () => {
  test("pivots on service and host without a query", () => {
    const { sql, params } = surroundingWhere({
      ts: "2026-08-14T15:00:00.000Z",
      service: "api",
      host: "api-1",
    });
    expect(sql).toContain("service = {service:String}");
    expect(sql).toContain("host = {host:String}");
    expect(sql).not.toContain("level =");
    expect(params.service).toBe("api");
    expect(params.host).toBe("api-1");
  });

  test("Matching ANDs the search bar onto the pivot", () => {
    const { sql, params } = surroundingWhere({
      ts: "2026-08-14T15:00:00.000Z",
      service: "api",
      q: "level:error timeout status:503",
    });
    expect(sql).toContain("level = {qp0:String}");
    expect(sql).toContain("hasToken(lowerUTF8(message), {qp1:String})");
    expect(sql).not.toContain("hasPhrase");
    expect(sql).toContain("attr_map[{qp3:String}] = {qp2:String}");
    expect(params.qp0).toBe("error");
    expect(params.qp1).toBe("timeout");
    expect(params.qp2).toBe("503");
    expect(params.qp3).toBe("status");
  });

  test("Matching consecutive phrase uses hasSubstr, not hasPhrase", () => {
    const { sql, params } = surroundingWhere({
      ts: "2026-08-14T15:00:00.000Z",
      service: "api",
      q: '"deadline exceeded"',
    });
    expect(sql).toContain("hasSubstr(splitByNonAlpha(lowerUTF8(message))");
    expect(sql).not.toContain("hasPhrase");
    expect(sql).not.toContain("hasAllTokens");
    expect(params.qp0).toBe("deadline");
    expect(params.qp1).toBe("exceeded");
  });

  test("Matching ANDs a numeric comparison onto the pivot", () => {
    const { sql, params } = surroundingWhere({
      ts: "2026-08-14T15:00:00.000Z",
      service: "api",
      q: "duration_ms:>40",
    });
    expect(sql).toContain(
      "ifNull(toFloat64OrNull(attr_map[{qp0:String}]) > {qp1:Float64}, 0)",
    );
    expect(params.qp0).toBe("duration_ms");
    expect(params.qp1).toBe("40");
  });
});
