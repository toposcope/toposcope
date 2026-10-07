import { describe, expect, test } from "bun:test";
import { mapOtlpJson } from "./otlp";

function levelOf(record: Record<string, unknown>): string | undefined {
  const [event] = mapOtlpJson({
    resourceLogs: [
      { scopeLogs: [{ logRecords: [{ body: { stringValue: "disk failed" }, ...record }] }] },
    ],
  });
  return event?.level;
}

describe("OTLP severity", () => {
  // A collector that builds the record by hand sends a text and no number.
  test.each(["CRITICAL", "CRIT", "ALERT"])("text %s with no number is fatal", (text) => {
    expect(levelOf({ severityText: text })).toBe("fatal");
  });

  test("text SEVERE with no number is error", () => {
    expect(levelOf({ severityText: "SEVERE" })).toBe("error");
  });

  test("a severity number outranks a text that disagrees", () => {
    expect(levelOf({ severityText: "info", severityNumber: 17 })).toBe("error");
  });

  test("an unspecified number (0) is info, as a missing one is", () => {
    expect(levelOf({ severityNumber: 0 })).toBe("info");
  });
});
