import { describe, expect, test } from "bun:test";
import { flattenAttrs } from "./attrs";
import { liftIdentities } from "./identity";

describe("liftIdentities", () => {
  test("aliases service.version onto version and drops the dotted key", () => {
    expect(
      liftIdentities({
        "service.version": "v0.9",
        path: "/v1/checkout",
      }),
    ).toEqual({ version: "v0.9", path: "/v1/checkout" });
  });

  test("keeps a sender version and drops the duplicate service.version", () => {
    expect(
      liftIdentities({
        version: "v0.9",
        "service.version": "9.0.0",
      }),
    ).toEqual({ version: "v0.9" });
  });

  test("stringifies a numeric service.version", () => {
    expect(liftIdentities({ "service.version": 9 })).toEqual({ version: "9" });
  });

  test("does not invent customer or flag", () => {
    expect(liftIdentities({ path: "/v1" })).toEqual({ path: "/v1" });
    expect(liftIdentities(undefined)).toBeUndefined();
  });

  test("leaves a non-string service.version it cannot lift", () => {
    const frames = { build: { sha: "abc" } };
    expect(liftIdentities({ "service.version": frames })).toEqual({
      "service.version": frames,
    });
  });

  test("flattenAttrs stores version for q", () => {
    const flat = flattenAttrs(
      liftIdentities({ "Service.Version": "v0.9", status: 500 }),
    );
    expect(flat.version).toBe("v0.9");
    expect(flat["service.version"]).toBeUndefined();
    expect(flat.status).toBe("500");
  });
});
