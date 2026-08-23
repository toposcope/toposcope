import { describe, expect, test } from "bun:test";
import {
  InvalidChangeMarkError,
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
  test("stamps ts and flattens attrs", () => {
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
    expect(Date.parse(mark.ts)).not.toBeNaN();
  });

  test("rejects a missing title or unknown kind", () => {
    expect(() => parseChangeMark({ kind: "deploy" })).toThrow(
      InvalidChangeMarkError,
    );
    expect(() => parseChangeMark({ kind: "release", title: "v0.9" })).toThrow(
      InvalidChangeMarkError,
    );
  });
});
