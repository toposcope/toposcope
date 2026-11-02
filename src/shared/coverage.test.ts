import { describe, expect, test } from "bun:test";
import { applyAccepted, buildCoverage, coverageGaps, coverageNotes, mismatchSo, nameKey, stackAccepted, type CoverageInput } from "./coverage";

/** Sheet 37's instance (37j / 37k), as rollup counts. */
function sheet(): CoverageInput {
  const logs = [
    { service: "api", rows: 1000, host_rows: 1000, error_rows: 100 },
    { service: "billing", rows: 640, host_rows: 640, error_rows: 100 },
    { service: "checkout", rows: 512, host_rows: 512, error_rows: 100 },
    { service: "auth", rows: 380, host_rows: 380, error_rows: 100 },
    { service: "worker", rows: 302, host_rows: 302, error_rows: 100 },
  ];
  return {
    from: "2026-11-01T14:40:00.000Z",
    to: "2026-11-02T14:40:00.000Z",
    logs,
    keys: [
      { service: "api", version: 1000, trace_id: 960, stack: 94 },
      { service: "billing", version: 0, trace_id: 0, stack: 41 },
      { service: "checkout", version: 512, trace_id: 480, stack: 97 },
      { service: "auth", version: 380, trace_id: 46, stack: 100 },
      { service: "worker", version: 215, trace_id: 0, stack: 12 },
    ],
    versions: [
      { service: "api", value: "1.4.2", n: 600 },
      { service: "api", value: "1.4.1", n: 400 },
    ],
    deploys: [
      { id: "m3", ts: "2026-11-02T14:02:00.000Z", service: "api", version: "v1.4.2" },
      { id: "m2", ts: "2026-11-02T12:00:00.000Z", service: "api", version: "1.4.1" },
      { id: "m1", ts: "2026-11-02T10:00:00.000Z", service: "api", version: "1.4.0" },
      { id: "c1", ts: "2026-11-02T09:40:00.000Z", service: "checkout", version: "2.0" },
      { id: "a1", ts: "2026-11-02T11:15:00.000Z", service: "auth", version: "" },
      { id: "a0", ts: "2026-11-02T08:00:00.000Z", service: "auth", version: "" },
    ],
    spans: [
      { service: "api", n: 10 },
      { service: "billing", n: 1 },
      { service: "checkout", n: 10 },
      { service: "auth", n: 10 },
      { service: "billing-api", n: 210_000 },
    ],
    metrics: [{ service: "billing-api", names: 14 }],
  };
}

describe("coverage (#391)", () => {
  test("2 of 5 complete, as 37j counts", () => {
    const c = buildCoverage(sheet());
    expect(c.services.map((s) => s.service)).toEqual(["api", "billing", "checkout", "auth", "worker"]);
    expect(c.complete).toBe(2);
    expect(c.services.find((s) => s.service === "worker")!.trace_id).toBeNull();
    expect(c.services.find((s) => s.service === "api")!.marks).toEqual({ count: 3, last: "2026-11-02T14:02:00.000Z" });
  });

  test("names that do not match: a suffix on spans and metrics, a v on a mark", () => {
    const c = buildCoverage(sheet());
    expect(c.mismatches).toHaveLength(2);
    expect(c.mismatches[0]).toEqual({ kind: "service", service: "billing", rows: 640, other: "billing-api", spans: 210_000, metric_names: 14, marks: null });
    expect(c.mismatches[1]).toMatchObject({ kind: "version", service: "api", rows_value: "1.4.2", mark_value: "v1.4.2", prior: "1.4.1", mark_id: "m3" });
    expect(mismatchSo(c.mismatches[0]!)).toBe(
      "Its spans and its logs read as two services: a hunt on service:billing never shows the metrics or the waterfall beside its rows.",
    );
    expect(mismatchSo(c.mismatches[1]!)).toBe("The mark is not tied to the rows it shipped, so nothing can tell 1.4.2 rows from 1.4.1 rows around it.");
  });

  test("a mark that matches its rows, or names no version, is no mismatch", () => {
    const input = sheet();
    input.deploys = [{ id: "x", ts: "2026-11-02T14:02:00.000Z", service: "api", version: "1.4.2" }];
    expect(buildCoverage(input).mismatches.filter((m) => m.kind === "version")).toEqual([]);
    expect(nameKey("Billing-API")).toBe("billing");
    expect(nameKey("v1.2")).toBe("1.2");
  });

  test("Home's lines: the selected mark's mismatch first, then the worst gap of each service", () => {
    const c = buildCoverage(sheet());
    expect(coverageGaps(c, "m3")).toEqual([
      expect.objectContaining({ service: "api", mark: true, what: "this mark says v1.4.2, its rows say 1.4.2: the rows it shipped cannot be told from the ones before", fix: "Names that do not match ›" }),
      expect.objectContaining({ service: "billing", what: "no version and no deploy mark: a billing release never becomes the mark Home measures from", fix: "Send version ↗" }),
      expect.objectContaining({ service: "worker", what: "88% of its errors carry no stack: their fingerprint comes from the message, so a reworded one reads as new", fix: "Attach the exception ↗" }),
      expect.objectContaining({ service: "auth", what: "trace_id on 12% of rows: View trace is missing on most of them", fix: "Log inside a span ↗" }),
    ]);
    // another mark selected: api is complete, so it has no line
    expect(coverageGaps(c, "m2").map((g) => g.service)).toEqual(["billing", "worker", "auth"]);
  });

  test("the notes under the table name what costs Home its answer", () => {
    expect(coverageNotes(buildCoverage(sheet()))).toEqual([
      { service: "billing", kind: "version", noMark: true },
      { service: "worker", kind: "stack", missing: "88%" },
    ]);
  });

  describe("accepted gaps (#392)", () => {
    const at = Date.parse("2026-11-02T14:40:00Z");
    test("a held gap leaves Home, the notes and the count; the cell keeps its number", () => {
      const { coverage, cleared } = applyAccepted(buildCoverage(sheet()), [
        { service: "auth", key: "trace_id", share: 0.12, by: null, at },
        { service: "worker", key: "stack", share: 0.12, by: null, at },
      ]);
      expect(cleared).toEqual([]);
      expect(coverage.accepted!.map((a) => a.state)).toEqual(["holds", "holds"]);
      const auth = coverage.services.find((s) => s.service === "auth")!;
      expect(auth.trace_id).toBeCloseTo(0.121, 2);
      expect(auth.complete).toBe(true);
      expect(coverage.complete).toBe(3);
      expect(coverageGaps(coverage, null).map((g) => g.service)).toEqual(["billing", "worker"]);
      // worker's next gap is its version, once its stack is accepted
      expect(coverageGaps(coverage, null)[1]!.what).toBe("version on 71% of rows: the rest cannot be told apart by release");
      expect(coverageNotes(coverage).map((n) => n.service)).toEqual(["billing"]);
      expect(stackAccepted(coverage, "worker")).toBe(true);
    });

    test("a gap comes back below its share at accept, and is cleared at 90%", () => {
      const input = sheet();
      input.keys = input.keys.map((k) => (k.service === "worker" ? { ...k, stack: 4 } : k.service === "auth" ? { ...k, trace_id: 380 } : k));
      const { coverage, cleared } = applyAccepted(buildCoverage(input), [
        { service: "auth", key: "trace_id", share: 0.12, by: null, at },
        { service: "worker", key: "stack", share: 0.12, by: null, at },
      ]);
      expect(cleared.map((r) => r.service)).toEqual(["auth"]);
      expect(coverage.accepted).toEqual([expect.objectContaining({ service: "worker", key: "stack", now: 0.04, state: "back" })]);
      expect(stackAccepted(coverage, "worker")).toBe(false);
      expect(coverageGaps(coverage, null).map((g) => g.service)).toContain("worker");
    });

    test("a deploy mark can be accepted, and is cleared when one arrives", () => {
      const held = applyAccepted(buildCoverage(sheet()), [{ service: "billing", key: "marks", share: 0, by: null, at }]);
      expect(held.coverage.accepted![0]!.state).toBe("holds");
      expect(coverageNotes(held.coverage)).toContainEqual({ service: "billing", kind: "version", noMark: false });
      const input = sheet();
      input.deploys.push({ id: "b1", ts: "2026-11-02T13:00:00.000Z", service: "billing", version: "" });
      expect(applyAccepted(buildCoverage(input), [{ service: "billing", key: "marks", share: 0, by: null, at }]).cleared).toHaveLength(1);
    });
  });
});
