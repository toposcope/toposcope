import { describe, expect, test } from "bun:test";
import { eventCursor, parseEventCursor } from "./event-cursor";

describe("Load more's cursor (#133)", () => {
  test("time and arrival sequence, round trip", () => {
    const c = eventCursor({ ts: "2026-10-17T06:00:00.123Z", seq: 4021 });
    expect(c).toBe("2026-10-17T06:00:00.123Z~4021");
    expect(parseEventCursor(c)).toEqual({ ts: "2026-10-17T06:00:00.123Z", seq: 4021 });
  });

  test("a row stored before the sequence pages by time alone, as before", () => {
    expect(eventCursor({ ts: "2026-10-17T06:00:00.123Z" })).toBe("2026-10-17T06:00:00.123Z");
    expect(parseEventCursor("2026-10-17T06:00:00.123Z")).toEqual({ ts: "2026-10-17T06:00:00.123Z", seq: null });
    expect(parseEventCursor("2026-10-17T06:00:00.123Z~0").seq).toBeNull();
    expect(parseEventCursor("2026-10-17T06:00:00.123Z~x")).toEqual({ ts: "2026-10-17T06:00:00.123Z~x", seq: null });
  });
});
