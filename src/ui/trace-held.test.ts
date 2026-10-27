import { describe, expect, test } from "bun:test";
import type { HeldSource } from "../shared/held";
import type { Span } from "../shared/span";
import { enteredRow, profileHeld, traceClock, traceHeld, type HeldPart } from "./trace-held";

const now = Date.parse("2026-10-27T13:23:40Z");
const at = (t: string) => Date.parse(`2026-10-27T${t}Z`);
const src = (over: Partial<HeldSource> & { name: string }): HeldSource => ({ filters: [], state: { kind: "caught-up" }, hole: null, ...over });
const text = (parts: HeldPart[] | null) => parts?.map((p) => p.text).join("") ?? null;

function span(id: string, from: string, ms: number, toposcope: string, pulled: boolean): Span {
  return {
    trace_id: "t",
    span_id: id,
    parent_span_id: "",
    service: "svc",
    name: id,
    ts: new Date(at("13:23:19") + Number(from)).toISOString(),
    duration_ms: ms,
    status: "ok",
    attrs: {},
    toposcope,
    pulled_at: pulled ? "2026-10-27T13:23:24.000Z" : null,
  };
}

// 33d: four spans entered at edge-1, three at edge-2; edge-2 is read to 13:23:19.910.
const spans = [
  span("a", "0", 1180, "edge-1", true),
  span("b", "12", 64, "edge-1", true),
  span("c", "80", 120, "edge-1", true),
  span("d", "210", 820, "edge-1", true),
  span("e", "224", 790, "edge-2", true),
  span("f", "236", 92, "edge-2", true),
  span("g", "340", 402, "edge-2", true),
];
const base = at("13:23:19");
const edge1 = src({ name: "edge-1" });
const edge2Behind = src({ name: "edge-2", state: { kind: "behind", readTo: base + 910 } });

describe("a trace says where its spans entered (#330, 33d)", () => {
  test("spans from two sources: a chip each, and one amber line naming the short one", () => {
    const v = traceHeld({ spans, sources: [edge1, edge2Behind], now, here: "central", baseMs: base, totalMs: 1180 });
    expect(v.linked).toBe(true);
    expect(v.instances).toBe(2);
    expect(v.chips.map((c) => [c.name, c.words, c.state])).toEqual([
      ["edge-1", "4 spans · caught up", "caught-up"],
      ["edge-2", "3 spans · short", "short"],
    ]);
    expect(text(v.line)).toBe(
      "edge-2 is read to 13:23:19.910, inside this trace. Spans that entered at edge-2 after that are not here yet, so this trace may be missing some. It fills in as edge-2 catches up.",
    );
    expect(v.line?.filter((p) => p.mono).map((p) => p.text)).toEqual(["edge-2", "13:23:19.910"]);
    expect(v.lineSource).toBe("edge-2");
    expect(v.short).toBe(true);
    expect(v.hatches).toEqual([
      { key: "edge-2:behind", source: "edge-2", kind: "behind", lo: 910 / 1180, hi: 1, label: "spans from edge-2 after 13:23:19.910", tag: "not here yet" },
    ]);
  });

  test("once the source catches up the trace reads whole: no line, no hatch", () => {
    const v = traceHeld({ spans, sources: [edge1, src({ name: "edge-2" })], now, here: "central", baseMs: base, totalMs: 1180 });
    expect([v.line, v.hatches, v.short]).toEqual([null, [], false]);
    expect(v.chips.map((c) => c.words)).toEqual(["4 spans · caught up", "3 spans · caught up"]);
  });

  test("a source read to after the trace ended is not short inside it", () => {
    const later = src({ name: "edge-2", state: { kind: "behind", readTo: base + 5_000 } });
    expect(traceHeld({ spans, sources: [edge1, later], now, here: "central", baseMs: base, totalMs: 1180 }).short).toBe(false);
  });

  test("a short source with no spans here yet still says so: the trace never reads as complete", () => {
    const own = [span("a", "0", 100, "central", false)];
    const v = traceHeld({ spans: own, sources: [edge2Behind], now, here: "central", baseMs: base, totalMs: 1180 });
    expect(v.chips.map((c) => [c.name, c.words, c.state])).toEqual([
      ["central", "1 span", "here"],
      ["edge-2", "no spans here · short", "short"],
    ]);
    expect(v.short).toBe(true);
  });

  test("with no spans here, the log's time decides whether a source is short", () => {
    const v = traceHeld({ spans: [], sources: [edge2Behind], now, here: "central", baseMs: 0, totalMs: 0, at: base + 2_000 });
    expect(v.short).toBe(true);
    expect(v.hatches[0]?.lo).toBe(0);
  });

  test("two short sources share one line naming both", () => {
    const edge1Quiet = src({ name: "edge-1", state: { kind: "quiet", since: base + 100, knownTo: base + 100, connects: "we" } });
    const v = traceHeld({ spans, sources: [edge1Quiet, edge2Behind], now, here: "central", baseMs: base, totalMs: 1180 });
    expect(text(v.line)).toStartWith("edge-1, edge-2 are short inside this trace.");
    expect(v.lineSource).toBeNull();
    expect(v.hatches).toHaveLength(2);
  });

  test("a hole inside the trace says its spans are gone, not on their way", () => {
    const hole = src({ name: "edge-2", hole: { from: base + 300, to: base + 600 } });
    const v = traceHeld({ spans, sources: [edge1, hole], now, here: "central", baseMs: base, totalMs: 1180 });
    expect(v.hatches[0]?.tag).toBe("gone at source");
    expect(v.hatches[0]?.hi).toBeCloseTo(600 / 1180);
    expect(text(v.line)).toContain("are gone, so this trace may be missing some.");
  });

  test("an instance that pulls from no one draws nothing new", () => {
    const own = [span("a", "0", 100, "", false)];
    const v = traceHeld({ spans: own, sources: [], now, here: "", baseMs: base, totalMs: 100 });
    expect(v.linked).toBe(false);
    expect(v.line).toBeNull();
  });

  test("a trace's clock keeps its milliseconds", () => {
    expect(traceClock(base + 910, now)).toBe("13:23:19.910");
    expect(traceClock(Date.parse("2026-10-26T23:58:02.005Z"), now)).toBe("10-26 23:58:02.005");
  });
});

describe("a span's rail names where it entered (#330)", () => {
  test("pulled: the source, and when it came over its link", () => {
    expect(enteredRow(spans[6]!, [edge1, edge2Behind], now, "central")).toEqual({ value: "edge-2", note: "pulled 13:23:24 over edge-2's link" });
  });

  test("through a relay: over the one link this instance has", () => {
    expect(enteredRow(span("x", "0", 1, "edge-9", true), [src({ name: "relay" })], now, "central").note).toBe("pulled 13:23:24 over relay's link");
    expect(enteredRow(span("x", "0", 1, "edge-9", true), [edge1, edge2Behind], now, "central").note).toBe("pulled 13:23:24");
  });

  test("entered here: this instance's name", () => {
    expect(enteredRow(span("x", "0", 1, "central", false), [edge1], now, "central")).toEqual({ value: "central", note: "entered here" });
    expect(enteredRow(span("x", "0", 1, "", false), [edge1], now, "central").value).toBe("central");
  });
});

describe("a profile says where it entered (#332, 33f)", () => {
  // A span that ends after edge-2's read position, 13:23:19.910.
  const pulledSpan = { ts: new Date(base + 800).toISOString(), duration_ms: 300, toposcope: "edge-2", pulled_at: "2026-10-27T13:23:24.000Z" };

  test("found: entered at its source, copied with its span", () => {
    const v = profileHeld({
      profile: { toposcope: "edge-2", pulled_at: "2026-10-27T13:23:24.000Z", stacks: [{}] },
      span: pulledSpan,
      sources: [edge2Behind],
      now,
      here: "central",
    });
    expect(v).toEqual({ entered: { name: "edge-2", note: "copied with its span" }, notHereYet: null });
  });

  test("none found while its span's source is read to before the span ended: its profile is not here yet", () => {
    const v = profileHeld({ profile: { toposcope: "", pulled_at: null, stacks: [] }, span: pulledSpan, sources: [edge1, edge2Behind], now, here: "central" });
    expect(v.entered).toEqual({ name: "edge-2", note: "copied with its span" });
    expect(text(v.notHereYet)).toBe(
      "edge-2 is read to 13:23:19.910, before this span ended. A profile goes over a link with its span, so it fills in as edge-2 catches up.",
    );
  });

  test("none found once the source is past the span: an empty view, as before", () => {
    const v = profileHeld({ profile: { toposcope: "", pulled_at: null, stacks: [] }, span: pulledSpan, sources: [src({ name: "edge-2" })], now, here: "central" });
    expect(v.notHereYet).toBeNull();
  });

  test("another source being short says nothing about a span that entered here", () => {
    const own = { ts: pulledSpan.ts, duration_ms: 300, toposcope: "central", pulled_at: null };
    const v = profileHeld({ profile: { toposcope: "", pulled_at: null, stacks: [] }, span: own, sources: [edge2Behind], now, here: "central" });
    expect(v).toEqual({ entered: { name: "central", note: "entered here" }, notHereYet: null });
  });

  test("unlinked and entered here: nothing named", () => {
    const own = { ts: pulledSpan.ts, duration_ms: 300, toposcope: "", pulled_at: null };
    expect(profileHeld({ profile: { toposcope: "", pulled_at: null, stacks: [{}] }, span: own, sources: [], now, here: "" }).entered).toBeNull();
  });
});
