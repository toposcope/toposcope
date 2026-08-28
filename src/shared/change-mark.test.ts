import { describe, expect, test } from "bun:test";
import {
  InvalidChangeMarkError,
  ciDeployMark,
  ciDeployMarkId,
  fallbackChangeMarkId,
  formatChangeMarkLabel,
  keepLatestChangeMarkPerId,
  marksToInsert,
  parseChangeMark,
  parseChangeMarkKind,
  parseChangeMarkRequest,
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
    expect(parseChangeMarkRequest({ kind: "note", title: "x", id: "pd-238" }).idProvided).toBe(
      true,
    );
    expect(parseChangeMarkRequest({ kind: "note", title: "x" }).idProvided).toBe(
      false,
    );
  });

  test("rejects a bad id", () => {
    expect(() =>
      parseChangeMark({ kind: "note", title: "x", id: "has space" }),
    ).toThrow(InvalidChangeMarkError);
  });

  test("accepts end_ts with a caller id when ts is omitted", () => {
    expect(() =>
      parseChangeMark({
        kind: "incident",
        title: "INC-238",
        id: "pd-238",
        end_ts: "2026-08-25T13:02:00.000Z",
      }),
    ).not.toThrow();
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

describe("ciDeployMark", () => {
  test("builds a stable id from service and tag", () => {
    const mark = ciDeployMark({
      title: "v0.9",
      sha: "abc123",
      service: "billing",
      source: "github",
    });
    expect(mark).toEqual({
      kind: "deploy",
      title: "v0.9",
      service: "billing",
      id: "deploy-billing-v0.9",
      attrs: { version: "v0.9", sha: "abc123", source: "github" },
    });
    expect(ciDeployMarkId("", "v0.4.5")).toBe("deploy-v0.4.5");
    expect(ciDeployMarkId("api", "feat/foo")).toBe("deploy-api-feat-foo");
  });
});

describe("marksToInsert", () => {
  test("skips a caller id that already landed", () => {
    const first = parseChangeMarkRequest({
      kind: "deploy",
      title: "v0.9",
      id: "deploy-billing-v0.9",
      service: "billing",
    });
    const retry = parseChangeMarkRequest({
      kind: "deploy",
      title: "v0.9",
      id: "deploy-billing-v0.9",
      service: "billing",
    });
    expect(marksToInsert([first], [])).toHaveLength(1);
    expect(marksToInsert([retry], ["deploy-billing-v0.9"])).toHaveLength(0);
    expect(marksToInsert([first, retry], [])).toHaveLength(1);
  });

  test("still inserts a minted id", () => {
    const minted = parseChangeMarkRequest({ kind: "note", title: "hello" });
    expect(minted.idProvided).toBe(false);
    expect(marksToInsert([minted], [minted.mark.id])).toHaveLength(1);
  });

  test("does not skip end_ts on a caller id that is still open", () => {
    const resolved = parseChangeMarkRequest({
      kind: "incident",
      title: "INC-238",
      id: "pd-238",
      ts: "2026-08-25T12:00:00.000Z",
      end_ts: "2026-08-25T13:02:00.000Z",
    });
    const inserted = marksToInsert([resolved], ["pd-238"]);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.end_ts).toBe("2026-08-25T13:02:00.000Z");
  });

  test("allows open then close of the same id in one batch", () => {
    const opened = parseChangeMarkRequest({
      kind: "incident",
      title: "INC-238",
      id: "pd-238",
      ts: "2026-08-25T12:00:00.000Z",
    });
    const resolved = parseChangeMarkRequest({
      kind: "incident",
      title: "INC-238",
      id: "pd-238",
      ts: "2026-08-25T12:00:00.000Z",
      end_ts: "2026-08-25T13:02:00.000Z",
    });
    expect(marksToInsert([opened, resolved], [])).toHaveLength(2);
  });
});

describe("keepLatestChangeMarkPerId", () => {
  test("one glyph when CI retried the same id", () => {
    const older = parseChangeMark({
      kind: "deploy",
      title: "v0.9",
      id: "deploy-billing-v0.9",
      ts: "2026-08-23T15:00:00.000Z",
    });
    const newer = parseChangeMark({
      kind: "deploy",
      title: "v0.9",
      id: "deploy-billing-v0.9",
      ts: "2026-08-23T16:00:00.000Z",
    });
    const other = parseChangeMark({
      kind: "deploy",
      title: "v0.8",
      id: "deploy-billing-v0.8",
      ts: "2026-08-22T12:00:00.000Z",
    });
    expect(keepLatestChangeMarkPerId([older, other, newer]).map((m) => m.id)).toEqual(
      ["deploy-billing-v0.8", "deploy-billing-v0.9"],
    );
    expect(keepLatestChangeMarkPerId([older, newer])[0]?.ts).toBe(
      "2026-08-23T16:00:00.000Z",
    );
  });

  test("closed row wins over an open row with the same ts", () => {
    const opened = parseChangeMark({
      kind: "incident",
      title: "INC-238",
      id: "pd-238",
      ts: "2026-08-25T12:00:00.000Z",
    });
    const closed = parseChangeMark({
      kind: "incident",
      title: "INC-238",
      id: "pd-238",
      ts: "2026-08-25T12:00:00.000Z",
      end_ts: "2026-08-25T13:02:00.000Z",
    });
    expect(keepLatestChangeMarkPerId([closed, opened])[0]?.end_ts).toBe(
      "2026-08-25T13:02:00.000Z",
    );
  });
});
