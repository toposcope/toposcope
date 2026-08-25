import { describe, expect, test } from "bun:test";
import type { ChangeMark } from "../shared/change-mark";
import {
  clusterChangeMarks,
  clusterHasLaneLabel,
  marksInBucket,
  panWindowToMark,
  peekCrowded,
  visibleChangeMarks,
} from "./change-marks";

function mark(
  id: string,
  ts: string,
  kind: ChangeMark["kind"] = "deploy",
): ChangeMark {
  return {
    id,
    ts,
    end_ts: null,
    kind,
    service: "billing",
    title: id,
    attrs: {},
  };
}

describe("visibleChangeMarks", () => {
  test("drops off kinds and muted ids", () => {
    const marks = [
      mark("a", "2026-08-25T12:00:00.000Z", "deploy"),
      mark("b", "2026-08-25T12:01:00.000Z", "flag"),
      mark("c", "2026-08-25T12:02:00.000Z", "deploy"),
    ];
    expect(
      visibleChangeMarks(marks, ["flag"], ["c"]).map((row) => row.id),
    ).toEqual(["a"]);
  });
});

describe("clusterChangeMarks", () => {
  test("fuses marks closer than the glyph gap", () => {
    const from = Date.parse("2026-08-25T12:00:00.000Z");
    const span = 60 * 60 * 1000;
    const marks = [
      mark("a", new Date(from + span * 0.5).toISOString()),
      mark("b", new Date(from + span * 0.505).toISOString()),
      mark("c", new Date(from + span * 0.8).toISOString()),
    ];
    const clusters = clusterChangeMarks(marks, span);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]?.members.map((row) => row.id)).toEqual(["a", "b"]);
    expect(clusters[1]?.members.map((row) => row.id)).toEqual(["c"]);
  });
});

describe("marksInBucket", () => {
  test("newest first inside the bar", () => {
    const bucket = Date.parse("2026-08-25T12:00:00.000Z");
    const step = 60_000;
    const rows = marksInBucket(
      [
        mark("old", "2026-08-25T12:00:10.000Z"),
        mark("new", "2026-08-25T12:00:40.000Z"),
        mark("out", "2026-08-25T12:01:00.000Z"),
      ],
      bucket,
      step,
    );
    expect(rows.map((row) => row.id)).toEqual(["new", "old"]);
  });
});

describe("clusterHasLaneLabel / peekCrowded", () => {
  test("hides the grammar string when another cluster is close", () => {
    const span = 3_600_000;
    const from = Date.parse("2026-08-25T12:00:00.000Z");
    const clusters = clusterChangeMarks(
      [
        mark("a", new Date(from + span * 0.2).toISOString()),
        mark("b", new Date(from + span * 0.25).toISOString()),
      ],
      span,
      0.001,
    );
    expect(clusterHasLaneLabel(clusters[0]!, clusters, span)).toBe(false);
  });

  test("crowds a peek when a member sits on that edge", () => {
    const from = Date.parse("2026-08-25T12:00:00.000Z");
    const span = 3_600_000;
    const clusters = clusterChangeMarks(
      [mark("a", new Date(from + span * 0.02).toISOString())],
      span,
    );
    expect(peekCrowded("left", clusters, from, span)).toBe(true);
    expect(peekCrowded("right", clusters, from, span)).toBe(false);
  });
});

describe("panWindowToMark", () => {
  test("keeps span and brings an outside mark to the edge", () => {
    const from = Date.parse("2026-08-25T12:00:00.000Z");
    const to = from + 3_600_000;
    const before = from - 11 * 60_000;
    expect(panWindowToMark(from, to, before)).toEqual({
      fromMs: before,
      toMs: before + 3_600_000,
    });
    const after = to + 8 * 60_000;
    expect(panWindowToMark(from, to, after)).toEqual({
      fromMs: after - 3_600_000,
      toMs: after,
    });
  });
});
