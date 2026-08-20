import { describe, expect, test } from "bun:test";
import {
  applyFieldValues,
  cheapSuggestKeys,
  coreFieldRows,
  coreRoleLabel,
  FIELD_TOP_CARD,
  graphMetricLabels,
  isChartableAttrValue,
  isChartSummaryKey,
  LINK_CAP,
  parseCheapKeys,
  parseFieldLinks,
  parseFieldRoles,
  parseFieldsWave,
  pickOverlapLink,
  shouldRollupAttrValue,
  skipKeysFromRoles,
  suggestFieldRole,
  suggestRolesFromKeys,
} from "./fields";

describe("parseFieldRoles", () => {
  test("stores lookup and ignore, drops default chart", () => {
    const parsed = parseFieldRoles({
      request_id: "lookup",
      debug_blob: "ignore",
      status: "chart",
    });
    expect(parsed).toEqual({ request_id: "lookup", debug_blob: "ignore" });
  });

  test("rejects level and core columns", () => {
    expect(parseFieldRoles({ level: "lookup" })).toEqual({
      error: 'Invalid role key "level"',
    });
    expect(parseFieldRoles({ service: "ignore" })).toEqual({
      error: 'Invalid role key "service"',
    });
    expect(parseFieldRoles({ message: "lookup" })).toEqual({
      error: 'Invalid role key "message"',
    });
  });
});

describe("parseFieldLinks", () => {
  test("accepts attr, service, and host", () => {
    expect(
      parseFieldLinks({ system: "source", service: "svc", host: "instance" }),
    ).toEqual({
      system: "source",
      service: "svc",
      host: "instance",
    });
  });

  test("rejects level and a ninth link", () => {
    expect(parseFieldLinks({ level: "lvl" })).toEqual({
      error: 'Invalid link key "level"',
    });
    expect(parseFieldLinks({ message: "source" })).toEqual({
      error: 'Invalid link key "message"',
    });
    const nine: Record<string, string> = {};
    for (let i = 0; i < LINK_CAP + 1; i++) {
      nine[`k${i}`] = "source";
    }
    expect(parseFieldLinks(nine)).toEqual({
      error: `At most ${LINK_CAP} links`,
    });
  });
});

describe("core catalog rows", () => {
  test("lists message as display-only text, not a role or link", () => {
    const rows = coreFieldRows(100, { service: 6, host: 24, level: 5 });
    expect(rows.map((row) => row.key)).toEqual([
      "service",
      "host",
      "level",
      "message",
    ]);
    const message = rows.find((row) => row.key === "message");
    expect(message).toEqual({
      key: "message",
      kind: "core",
      events: 100,
      values: null,
      roleable: false,
      linkable: false,
    });
    expect(coreRoleLabel("message")).toEqual({
      label: "text",
      title:
        "Bare words in the bar search this column as tokens, not a substring. Not a role.",
    });
    expect(coreRoleLabel("level").label).toBe("—");
    expect(coreRoleLabel("service").label).toBe("core column");
  });
});

describe("chartable values", () => {
  test("status rolls up; uuid and lookup do not", () => {
    expect(isChartableAttrValue("500")).toBe(true);
    expect(isChartableAttrValue("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(false);
    expect(
      isChartableAttrValue("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
    ).toBe(false);
    expect(isChartableAttrValue('{"a":1}')).toBe(false);
    expect(shouldRollupAttrValue("500", "chart")).toBe(true);
    expect(shouldRollupAttrValue("checkout", "lookup")).toBe(false);
    expect(shouldRollupAttrValue("checkout", "ignore")).toBe(false);
  });
});

describe("suggestFieldRole", () => {
  test("numeric stays quiet; unique and not-charted suggest lookup", () => {
    expect(suggestFieldRole("numeric", 100)).toBeNull();
    expect(suggestFieldRole(null, 40)).toBe("lookup");
    expect(suggestFieldRole(12, 40)).toBe("chart");
    expect(suggestFieldRole(800, 1000)).toBe("lookup");
    expect(suggestFieldRole(1000, 4000)).toBe("lookup");
  });
});

describe("pickOverlapLink", () => {
  test("picks the label whose top values overlap and does not invent a row", () => {
    expect(
      pickOverlapLink(["checkout", "billing"], {
        source: ["checkout", "edge"],
        instance: ["i-1"],
      }),
    ).toBe("source");
    expect(pickOverlapLink(["checkout"], { instance: ["i-1"] })).toBeNull();
  });
});

describe("graphMetricLabels", () => {
  test("maps system=checkout onto source without touching q", () => {
    expect(graphMetricLabels({ system: "source" }, "system", "checkout")).toEqual({
      source: "checkout",
    });
    expect(graphMetricLabels({}, "system", "checkout")).toBeNull();
  });
});

describe("skipKeysFromRoles", () => {
  test("lists lookup and ignore only", () => {
    expect(
      skipKeysFromRoles({ request_id: "lookup", noise: "ignore" }),
    ).toEqual(["noise", "request_id"]);
  });

  test("Add facet / Top-N skip lookup and ignore", () => {
    const roles = { request_id: "lookup" as const, noise: "ignore" as const };
    expect(isChartSummaryKey("status", roles)).toBe(true);
    expect(isChartSummaryKey("request_id", roles)).toBe(false);
    expect(isChartSummaryKey("noise", roles)).toBe(false);
  });
});

describe("fields catalog waves", () => {
  test("parseFieldsWave treats omit as the full catalog", () => {
    expect(parseFieldsWave(undefined)).toBeNull();
    expect(parseFieldsWave("")).toBeNull();
    expect(parseFieldsWave("keys")).toBe("keys");
    expect(parseFieldsWave("values")).toBe("values");
    expect(parseFieldsWave("suggest")).toBe("suggest");
    expect(parseFieldsWave("all")).toEqual({
      error: "wave must be keys, values, or suggest",
    });
  });

  test("cheap keys stay at the HLL cap and skip numeric / not-charted", () => {
    expect(parseCheapKeys("status,path,not a key,level")).toEqual([
      "status",
      "path",
    ]);
    expect(FIELD_TOP_CARD).toBe(1000);
    const keys = [
      {
        key: "service",
        kind: "core" as const,
        events: 100,
        values: 3,
        roleable: false,
        linkable: true,
      },
      {
        key: "status",
        kind: "attr" as const,
        events: 80,
        values: 12,
        roleable: true,
        linkable: true,
      },
      {
        key: "duration_ms",
        kind: "attr" as const,
        events: 80,
        values: "numeric" as const,
        roleable: true,
        linkable: true,
      },
      {
        key: "request_id",
        kind: "attr" as const,
        events: 80,
        values: 80_000,
        roleable: true,
        linkable: true,
      },
    ];
    expect(cheapSuggestKeys(keys)).toEqual(["service", "status"]);
    expect(
      applyFieldValues(keys, { status: 9, duration_ms: "numeric" }).map(
        (row) => [row.key, row.values],
      ),
    ).toEqual([
      ["service", 3],
      ["status", 9],
      ["duration_ms", "numeric"],
      ["request_id", null],
    ]);
    expect(
      suggestRolesFromKeys(
        applyFieldValues(keys, { status: 9, duration_ms: "numeric" }),
      ),
    ).toEqual({
      status: "chart",
      request_id: "lookup",
    });
  });
});
