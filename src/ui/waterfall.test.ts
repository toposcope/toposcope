import { describe, expect, test } from "bun:test";
import type { Span } from "../shared/span";
import {
  ancestorIds,
  flattenTrace,
  formatTraceMs,
  intervalUnionMs,
  traceTabLabel,
} from "./waterfall";

function span(partial: Partial<Span> & Pick<Span, "span_id">): Span {
  return {
    trace_id: "t",
    parent_span_id: "",
    service: "api",
    name: partial.span_id,
    ts: "2026-08-16T15:00:00.000Z",
    duration_ms: 10,
    status: "unset",
    attrs: {},
    ...partial,
  };
}

describe("formatTraceMs", () => {
  test("tenths under 100ms", () => {
    expect(formatTraceMs(32.4)).toBe("32.4ms");
    expect(formatTraceMs(412)).toBe("412ms");
  });
});

describe("intervalUnionMs", () => {
  test("overlaps count once", () => {
    expect(
      intervalUnionMs([
        { start: 0, duration: 10 },
        { start: 5, duration: 10 },
      ]),
    ).toBe(15);
  });
});

describe("flattenTrace", () => {
  test("nests children and computes exclusive self time", () => {
    const tree = flattenTrace([
      span({
        span_id: "a",
        service: "nginx",
        name: "GET /",
        duration_ms: 100,
      }),
      span({
        span_id: "b",
        parent_span_id: "a",
        service: "wordpress",
        ts: "2026-08-16T15:00:00.010Z",
        duration_ms: 40,
      }),
    ]);
    expect(tree.rows.map((row) => row.span.span_id)).toEqual(["a", "b"]);
    expect(tree.rows[0]?.depth).toBe(0);
    expect(tree.rows[1]?.depth).toBe(1);
    expect(tree.rows[0]?.selfMs).toBe(60);
    expect(tree.missingParent).toBe(false);
  });

  test("orphans sit under a missing parent", () => {
    const tree = flattenTrace([
      span({ span_id: "c", parent_span_id: "gone", duration_ms: 20 }),
      span({
        span_id: "d",
        parent_span_id: "c",
        ts: "2026-08-16T15:00:00.005Z",
        duration_ms: 4,
      }),
    ]);
    expect(tree.missingParent).toBe(true);
    expect(tree.orphanCount).toBe(1);
    expect(tree.rows[0]?.depth).toBe(1);
  });
});

describe("ancestorIds", () => {
  test("walks to the root", () => {
    const spans = [
      span({ span_id: "a" }),
      span({ span_id: "b", parent_span_id: "a" }),
      span({ span_id: "c", parent_span_id: "b" }),
    ];
    expect([...ancestorIds(spans, "c")].sort()).toEqual(["a", "b"]);
  });
});

describe("traceTabLabel", () => {
  test("keeps the first 12 characters", () => {
    expect(traceTabLabel("2620569ffffabc")).toBe("trace 2620569ffffa");
  });
});
