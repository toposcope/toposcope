import { describe, expect, test } from "bun:test";
import {
  eventsToCsv,
  eventsToJson,
  eventsToNdjson,
  exportScope,
} from "./export-events";
import type { LogEvent } from "./types";

const sample: LogEvent[] = [
  {
    ts: "2026-08-15T00:00:00.000Z",
    service: "api",
    host: "api-1",
    level: "error",
    message: "timeout, boom",
    attrs: { path: "/v1" },
  },
];

describe("exportScope", () => {
  test("names the query and range, or all events", () => {
    expect(exportScope("level:error", "1h")).toBe("level:error · 1h");
    expect(exportScope("  ", "custom")).toBe("all events · custom");
  });
});

describe("exportEvents", () => {
  test("csv quotes commas", () => {
    expect(eventsToCsv(sample)).toContain('"timeout, boom"');
    expect(eventsToCsv(sample).split("\n")[0]).toBe(
      "ts,level,service,host,message,attrs",
    );
  });

  test("json is an array", () => {
    expect(JSON.parse(eventsToJson(sample))).toHaveLength(1);
  });

  test("ndjson is one object per line", () => {
    const row = eventsToNdjson(sample).trim();
    expect(JSON.parse(row).message).toBe("timeout, boom");
  });
});
