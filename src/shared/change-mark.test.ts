import { describe, expect, test } from "bun:test";
import {
  InvalidChangeMarkError,
  fallbackChangeMarkId,
  formatChangeMarkLabel,
  parseChangeMark,
  parseChangeMarkKind,
} from "./change-mark";

describe("parseChangeMarkKind", () => {
  test("accepts the four kinds", () => {
    expect(parseChangeMarkKind("Deploy")).toBe("deploy");
    expect(parseChangeMarkKind("flag")).toBe("flag");
    expect(parseChangeMarkKind("incident")).toBe("incident");
    expect(parseChangeMarkKind("note")).toBe("note");
    expect(parseChangeMarkKind("release")).toBeNull();
  });
});

describe("parseChangeMark", () => {
  test("stamps ts, mints id, and flattens attrs", () => {
    const mark = parseChangeMark({
      kind: "deploy",
      title: "v0.9",
      service: "billing",
      attrs: { version: "v0.9", sha: "abc123" },
    });
    expect(mark.kind).toBe("deploy");
    expect(mark.title).toBe("v0.9");
    expect(mark.service).toBe("billing");
    expect(mark.attrs).toEqual({ version: "v0.9", sha: "abc123" });
    expect(mark.end_ts).toBeNull();
    expect(mark.id.startsWith("mk_")).toBe(true);
    expect(Date.parse(mark.ts)).not.toBeNaN();
  });

  test("keeps a caller id and optional end_ts", () => {
    const mark = parseChangeMark({
      kind: "incident",
      title: "INC-238",
      id: "pd-238",
      ts: "2026-08-25T12:00:00.000Z",
      end_ts: "2026-08-25T13:02:00.000Z",
    });
    expect(mark.id).toBe("pd-238");
    expect(mark.end_ts).toBe("2026-08-25T13:02:00.000Z");
  });

  test("rejects a bad id", () => {
    expect(() =>
      parseChangeMark({ kind: "note", title: "x", id: "has space" }),
    ).toThrow(InvalidChangeMarkError);
  });

  test("rejects a missing title, unknown kind, or end_ts not after ts", () => {
    expect(() => parseChangeMark({ kind: "deploy" })).toThrow(
      InvalidChangeMarkError,
    );
    expect(() => parseChangeMark({ kind: "release", title: "v0.9" })).toThrow(
      InvalidChangeMarkError,
    );
    expect(() =>
      parseChangeMark({
        kind: "incident",
        title: "INC-1",
        ts: "2026-08-25T13:00:00.000Z",
        end_ts: "2026-08-25T12:00:00.000Z",
      }),
    ).toThrow(InvalidChangeMarkError);
  });
});

describe("formatChangeMarkLabel", () => {
  test("deploy grammar includes service", () => {
    expect(
      formatChangeMarkLabel({
        kind: "deploy",
        service: "billing",
        title: "v0.9",
      }),
    ).toBe("deployed: billing v0.9");
    expect(
      formatChangeMarkLabel({ kind: "flag", service: "api", title: "new-pricing on" }),
    ).toBe("flag: new-pricing on");
  });
});

describe("fallbackChangeMarkId", () => {
  test("is stable for the same row", () => {
    const parts = {
      ts: "2026-08-25T12:00:00.000Z",
      kind: "deploy",
      service: "billing",
      title: "v0.9",
    };
    expect(fallbackChangeMarkId(parts)).toBe(fallbackChangeMarkId(parts));
    expect(fallbackChangeMarkId(parts).startsWith("mk_")).toBe(true);
  });
});
