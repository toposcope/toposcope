import { describe, expect, test } from "bun:test";
import type { ChangeMark } from "../shared/change-mark";
import {
  clusterChangeMarks,
  clusterHasLaneLabel,
  eventInIncidentWash,
  eventTableMarkLayout,
  foldMarkLabel,
  formatMarkDuration,
  incidentEndLabel,
  markFrac,
  markPlotSpanMs,
  marksInBucket,
  panWindowToMark,
  peekCrowded,
  visibleChangeMarks,
} from "./change-marks";
import { fillHistogram } from "./fill-histogram";

function mark(
  id: string,
  ts: string,
  kind: ChangeMark["kind"] = "deploy",
  endTs: string | null = null,
): ChangeMark {
  return {
    id,
    ts,
    end_ts: endTs,
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

describe("markFrac vs volume bars", () => {
  test("plot span is the painted columns, not the hunt clock", () => {
    const hour = 3_600_000;
    expect(markPlotSpanMs(7, hour, 6 * hour)).toBe(7 * hour);
    expect(markPlotSpanMs(0, hour, 6 * hour)).toBe(6 * hour);
  });

  test("a 16:32 mark on a 6h / 1h plot sits in the 16:00 bar", () => {
    const fromIso = "2026-08-25T13:02:05.127Z";
    const toIso = "2026-08-25T19:02:05.127Z";
    const stepMs = 3_600_000;
    const filled = fillHistogram(fromIso, toIso, [], stepMs);
    const fromMs = Date.parse(filled[0]!.t);
    const clockSpanMs = Date.parse(toIso) - Date.parse(fromIso);
    const ts = Date.parse("2026-08-25T16:32:14.000Z");
    const bar = filled.findIndex((bucket) => {
      const t = Date.parse(bucket.t);
      return ts >= t && ts < t + stepMs;
    });
    const frac = markFrac(
      ts,
      fromMs,
      markPlotSpanMs(filled.length, stepMs, clockSpanMs),
    );
    expect(filled.length).toBeGreaterThan(bar + 1);
    expect(frac).toBeGreaterThanOrEqual(bar / filled.length);
    expect(frac).toBeLessThan((bar + 1) / filled.length);
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

describe("formatMarkDuration", () => {
  test("keeps hours and leftover minutes for an incident span", () => {
    expect(formatMarkDuration(62 * 60_000)).toBe("1h 2m");
    expect(formatMarkDuration(60 * 60_000)).toBe("1h");
    expect(formatMarkDuration(15 * 60_000)).toBe("15m");
  });
});

describe("eventTableMarkLayout", () => {
  const rows = [
    { ts: "2026-08-14T14:59:51.688Z" },
    { ts: "2026-08-14T14:59:43.765Z" },
    { ts: "2026-08-14T14:58:59.120Z" },
    { ts: "2026-08-14T14:58:12.402Z" },
    { ts: "2026-08-14T14:57:48.331Z" },
  ];

  test("draws a seam between the rows it separates, not as an event", () => {
    const layout = eventTableMarkLayout(rows, [
      mark("v9", "2026-08-14T14:58:30.000Z"),
    ]);
    expect(layout.rows.map((row) => row.type)).toEqual([
      "event",
      "event",
      "event",
      "seam",
      "event",
      "event",
    ]);
    expect(layout.rows[3]).toMatchObject({ type: "seam", mark: { id: "v9" } });
    expect(layout.rows.filter((row) => row.type === "event")).toHaveLength(
      rows.length,
    );
    expect(layout.below).toEqual([]);
  });

  test("stacks two marks in the same gap and folds three", () => {
    const two = eventTableMarkLayout(rows, [
      mark("a", "2026-08-14T14:58:40.000Z"),
      mark("b", "2026-08-14T14:58:32.000Z"),
    ]);
    expect(
      two.rows
        .filter((row) => row.type === "seam")
        .map((row) => (row.type === "seam" ? row.mark.id : "")),
    ).toEqual(["a", "b"]);
    const three = eventTableMarkLayout(rows, [
      mark("a", "2026-08-14T14:58:40.000Z"),
      mark("b", "2026-08-14T14:58:32.000Z"),
      mark("c", "2026-08-14T14:58:25.000Z"),
    ]);
    const fold = three.rows.find((row) => row.type === "fold");
    expect(fold?.type).toBe("fold");
    if (fold?.type === "fold") {
      expect(fold.members.map((item) => item.id)).toEqual(["a", "b", "c"]);
      expect(foldMarkLabel(fold.members)).toBe("3 marks · 14:58 – 14:58");
    }
  });

  test("peeks marks older than the loaded page instead of drawing them", () => {
    const layout = eventTableMarkLayout(rows, [
      mark("in", "2026-08-14T14:58:30.000Z"),
      mark("old", "2026-08-14T14:11:04.000Z"),
    ]);
    expect(layout.below.map((item) => item.id)).toEqual(["old"]);
    expect(
      layout.rows.some((row) => row.type === "seam" && row.mark.id === "old"),
    ).toBe(false);
  });

  test("does not seam a mark newer than the loaded page onto the first row", () => {
    const slice = [
      { ts: "2026-08-25T16:29:37.400Z" },
      { ts: "2026-08-25T16:29:37.200Z" },
      { ts: "2026-08-25T16:29:37.050Z" },
      { ts: "2026-08-25T16:29:36.800Z" },
    ];
    const layout = eventTableMarkLayout(slice, [
      mark("later", "2026-08-25T16:32:14.000Z"),
      mark("also", "2026-08-25T16:31:58.000Z"),
      mark("here", "2026-08-25T16:29:37.100Z"),
    ]);
    expect(
      layout.rows
        .filter((row) => row.type === "seam")
        .map((row) => (row.type === "seam" ? row.mark.id : "")),
    ).toEqual(["here"]);
    expect(layout.above.map((item) => item.id)).toEqual(["later", "also"]);
    expect(layout.below).toEqual([]);
  });

  test("pins a focused mark above the page when Focus in logs has no newer rows", () => {
    const olderOnly = [
      { ts: "2026-08-25T16:32:13.900Z" },
      { ts: "2026-08-25T16:32:13.800Z" },
    ];
    const marks = [
      mark("focus", "2026-08-25T16:32:14.000Z"),
      mark("later", "2026-08-25T16:32:20.000Z"),
    ];
    const skipped = eventTableMarkLayout(olderOnly, marks);
    expect(skipped.above.map((item) => item.id)).toEqual(["later", "focus"]);
    expect(skipped.rows.filter((row) => row.type === "seam")).toEqual([]);
    const pinned = eventTableMarkLayout(olderOnly, marks, "focus");
    expect(pinned.above.map((item) => item.id)).toEqual(["later"]);
    expect(pinned.rows[0]).toMatchObject({ type: "seam", mark: { id: "focus" } });
  });

  test("washes rows inside an incident and draws the end rule", () => {
    const incident = mark(
      "inc",
      "2026-08-14T03:10:00.000Z",
      "incident",
      "2026-08-14T04:12:00.000Z",
    );
    incident.title = "INC-238 checkout 5xx";
    const page = [
      { ts: "2026-08-14T04:14:21.882Z" },
      { ts: "2026-08-14T04:08:12.400Z" },
      { ts: "2026-08-14T03:22:41.006Z" },
      { ts: "2026-08-14T03:04:55.610Z" },
    ];
    const layout = eventTableMarkLayout(page, [incident]);
    expect(layout.rows.map((row) => row.type)).toEqual([
      "event",
      "end",
      "event",
      "event",
      "seam",
      "event",
    ]);
    expect(incidentEndLabel(incident)).toBe("INC-238 checkout 5xx ends · 1h 2m");
    expect(eventInIncidentWash(page[0]!.ts, [incident])).toBe(false);
    expect(eventInIncidentWash(page[1]!.ts, [incident])).toBe(true);
    expect(eventInIncidentWash(page[2]!.ts, [incident])).toBe(true);
    expect(eventInIncidentWash(page[3]!.ts, [incident])).toBe(false);
  });
});
