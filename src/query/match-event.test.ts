import { describe, expect, test } from "bun:test";
import type { LogEvent } from "../shared/log-event";
import { eventMatchesQuery } from "./match-event";

const event: LogEvent = {
  ts: "2026-08-14T15:00:00.000Z",
  service: "api",
  host: "api-1",
  level: "error",
  message: "context deadline exceeded",
  attrs: { status: "503", path: "/v1/checkout" },
};

describe("eventMatchesQuery", () => {
  test("empty query matches everything", () => {
    expect(eventMatchesQuery(event, "")).toBe(true);
    expect(eventMatchesQuery(event, "   ")).toBe(true);
  });

  test("AND of field equality and message token", () => {
    expect(eventMatchesQuery(event, "level:error service:api timeout")).toBe(false);
    expect(eventMatchesQuery(event, "level:error deadline")).toBe(true);
    expect(eventMatchesQuery(event, "DEADLINE")).toBe(true);
    expect(eventMatchesQuery(event, "dead")).toBe(false);
    expect(eventMatchesQuery(event, "status:503 path:/v1/checkout")).toBe(true);
    expect(eventMatchesQuery(event, "status:500")).toBe(false);
    expect(eventMatchesQuery(event, "host:api-2")).toBe(false);
  });

  test("OR, prefix glob, phrase, and NOT", () => {
    expect(eventMatchesQuery(event, "level:error OR level:fatal")).toBe(true);
    expect(eventMatchesQuery(event, "level:info OR level:warn")).toBe(false);
    expect(eventMatchesQuery(event, "status:5*")).toBe(true);
    expect(eventMatchesQuery(event, "status:4*")).toBe(false);
    expect(eventMatchesQuery(event, '"deadline exceeded"')).toBe(true);
    expect(
      eventMatchesQuery(
        { ...event, message: "deadline was exceeded" },
        '"deadline exceeded"',
      ),
    ).toBe(false);
    expect(eventMatchesQuery({ ...event, message: "connection timeouts" }, "timeout")).toBe(
      false,
    );
    expect(eventMatchesQuery(event, "not level:error")).toBe(false);
    expect(eventMatchesQuery(event, "level:error OR")).toBe(false);
  });

  test("numeric comparisons parse the stored attr string", () => {
    const slow: LogEvent = {
      ...event,
      attrs: { ...event.attrs, duration_ms: "42" },
    };
    expect(eventMatchesQuery(slow, "duration_ms:>40")).toBe(true);
    expect(eventMatchesQuery(slow, "duration_ms:>=42")).toBe(true);
    expect(eventMatchesQuery(slow, "duration_ms:>100")).toBe(false);
    expect(eventMatchesQuery(slow, "duration_ms:42")).toBe(true);
    expect(eventMatchesQuery(slow, 'duration_ms:">100"')).toBe(false);
    expect(eventMatchesQuery(slow, "duration_ms:>40 duration_ms:<50")).toBe(true);
    expect(eventMatchesQuery(event, "status:>=500")).toBe(true);
    expect(eventMatchesQuery(event, "duration_ms:>100")).toBe(false);
    expect(eventMatchesQuery(event, "-duration_ms:>100")).toBe(true);
  });
});
