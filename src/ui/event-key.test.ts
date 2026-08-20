import { describe, expect, test } from "bun:test";
import { eventKey, eventRowKeys, indexOfEventKey } from "./event-key";
import type { LogEvent } from "./types";

const sample: LogEvent = {
  ts: "2026-08-14T12:00:01.000Z",
  service: "api",
  host: "api-1",
  level: "error",
  message: "timeout",
};

function twin(attrs: LogEvent["attrs"]): LogEvent {
  return {
    ts: "2026-08-16T23:43:14.857Z",
    service: "worker",
    host: "worker-1",
    level: "info",
    message: "user login live1786919122265",
    attrs,
  };
}

describe("eventKey", () => {
  test("finds the same event after the list shifts", () => {
    const newer: LogEvent = { ...sample, ts: "2026-08-14T12:00:02.000Z" };
    const events = [newer, sample];
    expect(indexOfEventKey(events, eventKey(sample))).toBe(1);
  });

  test("returns -1 when the event has left the page", () => {
    expect(indexOfEventKey([sample], "missing")).toBe(-1);
  });

  test("separates same-stamp rows that differ by request_id", () => {
    const a = twin({ request_id: "req-1", path: "/v1/users" });
    const b = twin({ request_id: "req-2", path: "/v1/users" });
    expect(eventKey(a)).not.toBe(eventKey(b));
  });

  test("treats attr key order as the same event", () => {
    const a = twin({ path: "/v1/users", request_id: "req-1" });
    const b = twin({ request_id: "req-1", path: "/v1/users" });
    expect(eventKey(a)).toBe(eventKey(b));
  });
});

describe("eventRowKeys", () => {
  test("keeps the identity key when the page has no twins", () => {
    const events = [sample, { ...sample, ts: "2026-08-14T12:00:02.000Z" }];
    expect(eventRowKeys(events)).toEqual(events.map(eventKey));
  });

  test("suffixes a true duplicate so React keys stay unique", () => {
    const keys = eventRowKeys([sample, sample]);
    expect(new Set(keys).size).toBe(2);
    expect(keys[0]).toBe(eventKey(sample));
    expect(keys[1]).toBe(`${eventKey(sample)}\0#1`);
  });
});
