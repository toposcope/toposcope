import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EventDetail, followKeyOf, markBeforeFirstSeen, shortId, stackOf } from "./components/event-detail";
import type { ChangeMark } from "../shared/change-mark";
import type { LogEvent } from "./types";

const mark = (id: string, kind: ChangeMark["kind"], ts: string): ChangeMark => ({ id, ts, end_ts: null, kind, service: "billing", title: id, attrs: {} });
const event: LogEvent = {
  ts: "2026-10-26T13:23:19.576Z",
  service: "billing",
  host: "billing-1",
  level: "error",
  message: "charge failed card_declined",
  attrs: { e1: "a91f2c", request_id: "r-7f20c3a1", trace_id: "8b3f0000000000000000000000001e1", "exception.stacktrace": "CardDeclined\n  at charge (billing.go:41)" },
};

describe("the event panel (#261, 26e)", () => {
  test("the mark just before first seen, within an hour, never a note", () => {
    const marks = [mark("billing v0.9", "deploy", "2026-10-26T12:48:00Z"), mark("raised limit", "note", "2026-10-26T12:49:00Z"), mark("api v2", "deploy", "2026-10-26T09:12:00Z")];
    expect(markBeforeFirstSeen("2026-10-26T12:49:30Z", marks)).toEqual({ mark: marks[0]!, minutes: 2 });
    expect(markBeforeFirstSeen("2026-10-26T11:00:00Z", marks)).toBeNull();
    expect(markBeforeFirstSeen(null, marks)).toBeNull();
  });
  test("the footer's Follow is the row's id-shaped attr; Stack is the exception's", () => {
    expect(followKeyOf(event, { request_id: "lookup" })).toEqual({ k: "request_id", v: "r-7f20c3a1" });
    // the trace id is the Trace button, never Follow
    expect(followKeyOf({ ...event, attrs: { trace_id: "8b3f0000000000000000000000001e1" } }, { trace_id: "lookup" })).toBeNull();
    expect(followKeyOf({ ...event, attrs: { e1: "a91f2c" } }, {})).toBeNull();
    expect(stackOf(event)).toContain("billing.go:41");
    expect(stackOf({ ...event, attrs: {} })).toBeNull();
    expect(shortId("8b3f0000000000000000000000001e1")).toBe("8b3f…e1");
  });
  test("renders the message, the fingerprint line, three tabs and words in the footer", () => {
    const html = renderToStaticMarkup(
      createElement(EventDetail, { event, roles: { request_id: "lookup" }, onClose: () => {}, onFilter: () => {}, onAround: () => {}, onFollow: () => {}, fromMs: 0, spanMs: 3_600_000 }),
    );
    expect(html).toContain("charge failed card_declined");
    expect(html).toContain("e1:a91f2c");
    expect(html).toContain(">Fields<");
    expect(html).toContain(">JSON<");
    expect(html).toContain(">Stack<");
    expect(html).toContain("Surroundings");
    expect(html).toContain("Follow <span");
    expect(html).toContain("Copy JSON");
    expect(html).toContain("+ filter");
  });
});

import { railNameRooms } from "./components/histogram-marks";

describe("rail chip names (#260, 50i)", () => {
  test("a name gets its room from its neighbours and the rail's ends, cut to fit rather than dropped", () => {
    const name = "billing v0.9";
    const at = (frac: number, others: number[], laneW: number) =>
      railNameRooms([{ frac, name }, ...others.map((f) => ({ frac: f, name: null }))], laneW)[0];
    // Room enough: its whole name.
    expect(at(0.5, [0.1, 0.9], 1400)).toBe(Math.ceil(name.length * 6.8));
    // Crowded or at the rail's very end: glyph and time only.
    expect(at(0.5, [0.52], 1400)).toBe(0);
    expect(at(0.01, [], 1400)).toBe(0);
    // A narrow rail cuts the name to what fits, and never past the neighbour.
    const cut = at(0.5, [0.15], 300)!;
    expect(cut).toBeGreaterThan(0);
    expect(cut).toBeLessThan(Math.ceil(name.length * 6.8));
  });
});
