import { describe, expect, test } from "bun:test";
import {
  InvalidChangeMarkError,
  ciDeployMark,
  ciDeployMarkId,
  fallbackChangeMarkId,
  formatChangeMarkLabel,
  keepLatestChangeMarkPerId,
  marksIngestBody,
  marksToInsert,
  parseChangeMark,
  parseChangeMarkKind,
  parseChangeMarkRequest,
  type ChangeMarkClockState,
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

  test("O3 close may omit ts even when end_ts is in the past", () => {
    const parsed = parseChangeMarkRequest({
      kind: "incident",
      title: "INC-238",
      id: "pd-238",
      end_ts: "2026-08-25T13:02:00.000Z",
    });
    expect(parsed.tsProvided).toBe(false);
    expect(parsed.mark.end_ts).toBe("2026-08-25T13:02:00.000Z");
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
  const now = "2026-08-31T12:00:00.000Z";
  const start = "2026-08-25T12:00:00.000Z";
  const end = "2026-08-25T13:02:00.000Z";
  const later = "2026-08-31T18:00:00.000Z";
  const futureEnd = "2026-08-31T14:00:00.000Z";

  function clock(
    id: string,
    ts: string,
    endTs: string | null = null,
  ): ChangeMarkClockState {
    return { id, ts, end_ts: endTs };
  }

  function insert(
    body: Record<string, unknown>,
    existing: ChangeMarkClockState[] = [],
  ) {
    return marksToInsert([parseChangeMarkRequest(body)], existing, now);
  }

  test("M1 mints an open mark at now", () => {
    const rows = insert({ kind: "note", title: "hello" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id.startsWith("mk_")).toBe(true);
    expect(rows[0]?.ts).toBe(now);
    expect(rows[0]?.end_ts).toBeNull();
  });

  test("M2 keeps a supplied start when minting", () => {
    const rows = insert({ kind: "note", title: "hello", ts: start });
    expect(rows[0]?.ts).toBe(start);
  });

  test("M3 mints a band that starts now", () => {
    const rows = insert({
      kind: "incident",
      title: "window",
      end_ts: futureEnd,
    });
    expect(rows[0]?.ts).toBe(now);
    expect(rows[0]?.end_ts).toBe(futureEnd);
  });

  test("M3 refuses a band that would end before now", () => {
    expect(() =>
      insert({ kind: "incident", title: "window", end_ts: end }),
    ).toThrow(InvalidChangeMarkError);
  });

  test("M4 mints a band with both clocks", () => {
    const rows = insert({
      kind: "incident",
      title: "window",
      ts: start,
      end_ts: end,
    });
    expect(rows[0]?.ts).toBe(start);
    expect(rows[0]?.end_ts).toBe(end);
  });

  test("N1–N4 insert a new caller id", () => {
    expect(
      insert({ kind: "incident", title: "INC-1", id: "n1" })[0]?.ts,
    ).toBe(now);
    expect(
      insert({ kind: "incident", title: "INC-1", id: "n2", ts: start })[0]?.ts,
    ).toBe(start);
    expect(
      insert({
        kind: "incident",
        title: "INC-1",
        id: "n3",
        end_ts: futureEnd,
      })[0],
    ).toEqual(
      expect.objectContaining({ ts: now, end_ts: futureEnd, id: "n3" }),
    );
    expect(
      insert({
        kind: "incident",
        title: "INC-1",
        id: "n4",
        ts: start,
        end_ts: end,
      })[0],
    ).toEqual(expect.objectContaining({ ts: start, end_ts: end, id: "n4" }));
  });

  test("O1 skips a CI retry of an open deploy (same id, no end_ts)", () => {
    const first = parseChangeMarkRequest({
      kind: "deploy",
      title: "v0.9",
      id: "deploy-billing-v0.9",
      service: "billing",
      ts: start,
    });
    const retry = parseChangeMarkRequest({
      kind: "deploy",
      title: "v0.9",
      id: "deploy-billing-v0.9",
      service: "billing",
    });
    expect(marksToInsert([first], [], now)).toHaveLength(1);
    expect(
      marksToInsert([retry], [clock("deploy-billing-v0.9", start)], now),
    ).toHaveLength(0);
    expect(marksToInsert([first, retry], [], now)).toHaveLength(1);
  });

  test("O2 skips an open id even when the body supplies a new ts", () => {
    const rows = insert(
      {
        kind: "incident",
        title: "INC-238",
        id: "pd-238",
        ts: later,
      },
      [clock("pd-238", start)],
    );
    expect(rows).toHaveLength(0);
  });

  test("O3 closes an open mark and keeps the stored start", () => {
    const rows = insert(
      {
        kind: "incident",
        title: "INC-238",
        id: "pd-238",
        end_ts: end,
      },
      [clock("pd-238", start)],
    );
    expect(rows).toEqual([
      expect.objectContaining({
        id: "pd-238",
        ts: start,
        end_ts: end,
      }),
    ]);
  });

  test("O4 closes and ignores an incoming ts that is after end_ts", () => {
    const rows = insert(
      {
        kind: "incident",
        title: "INC-238",
        id: "pd-238",
        ts: later,
        end_ts: end,
      },
      [clock("pd-238", start)],
    );
    expect(rows[0]?.ts).toBe(start);
    expect(rows[0]?.end_ts).toBe(end);
  });

  test("N4 refuses end_ts not after the supplied start", () => {
    expect(() =>
      insert({
        kind: "incident",
        title: "INC-1",
        id: "n4-bad",
        ts: later,
        end_ts: end,
      }),
    ).toThrow(InvalidChangeMarkError);
  });

  test("O3 refuses end_ts not after the stored start", () => {
    expect(() =>
      insert(
        {
          kind: "incident",
          title: "INC-238",
          id: "pd-238",
          end_ts: "2026-08-25T11:00:00.000Z",
        },
        [clock("pd-238", start)],
      ),
    ).toThrow(InvalidChangeMarkError);
  });

  test("open then close of the same id in one batch is two inserts", () => {
    const opened = parseChangeMarkRequest({
      kind: "incident",
      title: "INC-238",
      id: "pd-238",
      ts: start,
    });
    const resolved = parseChangeMarkRequest({
      kind: "incident",
      title: "INC-238",
      id: "pd-238",
      end_ts: end,
    });
    const rows = marksToInsert([opened, resolved], [], now);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.ts).toBe(start);
    expect(rows[1]?.end_ts).toBe(end);
  });

  test("X1–X4 skip a closed id (not a reopen)", () => {
    const closed = [clock("pd-238", start, end)];
    expect(
      insert({ kind: "incident", title: "INC-238", id: "pd-238" }, closed),
    ).toHaveLength(0);
    expect(
      insert(
        { kind: "incident", title: "INC-238", id: "pd-238", ts: later },
        closed,
      ),
    ).toHaveLength(0);
    expect(
      insert(
        {
          kind: "incident",
          title: "INC-238",
          id: "pd-238",
          end_ts: futureEnd,
        },
        closed,
      ),
    ).toHaveLength(0);
    expect(
      insert(
        {
          kind: "incident",
          title: "INC-238",
          id: "pd-238",
          ts: start,
          end_ts: end,
        },
        closed,
      ),
    ).toHaveLength(0);
  });

  test("still inserts a minted id even if that mk_ string is already stored", () => {
    const minted = parseChangeMarkRequest({ kind: "note", title: "hello" });
    expect(minted.idProvided).toBe(false);
    expect(
      marksToInsert(
        [minted],
        [clock(minted.mark.id, start)],
        now,
      ),
    ).toHaveLength(1);
  });
});

describe("marksIngestBody", () => {
  test("one object returns id; an array returns ids in request order", () => {
    expect(marksIngestBody(true, ["pd-238"], 1)).toEqual({
      ingested: 1,
      id: "pd-238",
    });
    expect(marksIngestBody(true, ["pd-238"], 0)).toEqual({
      ingested: 0,
      id: "pd-238",
    });
    expect(marksIngestBody(false, ["a", "b"], 1)).toEqual({
      ingested: 1,
      ids: ["a", "b"],
    });
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
    expect(keepLatestChangeMarkPerId([opened, closed])[0]?.end_ts).toBe(
      "2026-08-25T13:02:00.000Z",
    );
  });
});
