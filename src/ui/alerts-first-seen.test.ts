import { describe, expect, test } from "bun:test";
import { firstSeenMarksScope, monitorSentence } from "./alert-condition";

describe("the monitor dialog's words (#107, #175)", () => {
  test("a search monitor says what opens it, how it reminds, and that it resolves", () => {
    expect(monitorSentence({ name: "api p99 slow", agg: "p99:duration_ms", range: "15m" }, "800", "4h")).toBe(
      "Opens when api p99 slow’s p99(duration_ms) over its 15m is at or above 800, reminds every 4h while open, and says when it resolved.",
    );
    expect(monitorSentence({ name: "webhook failures", agg: null, range: null }, "5", "window")).toContain(
      "over its window is at or above 5, reminds every 5m while open",
    );
    expect(monitorSentence({ name: "api errors", agg: null, range: "15m" }, "50", "window")).toContain("reminds every 15m");
    expect(monitorSentence({ name: "api errors", agg: null, range: "15m" }, "50", "off")).toContain(
      "at or above 50, does not remind, and says when it resolved.",
    );
  });

  test("the marks a first-seen monitor watches, as its q scopes them", () => {
    expect(firstSeenMarksScope("level:error service:api")).toBe("on service api, or on no service");
    expect(firstSeenMarksScope("(service:api OR service:web) level:error")).toBe(
      "on service api or web, or on no service",
    );
    expect(firstSeenMarksScope("level:error")).toBe("on any service");
  });
});
