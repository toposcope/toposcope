import { describe, expect, test } from "bun:test";
import { parseBoard, type BoardPanel } from "./boards";
import { derivedPanelName, fieldWords, isGenericPanelName, measureWords, panelDisplayName, querySubject } from "./panel-name";
import { draftOf, fieldsOf } from "../ui/panel-draft";

function panel(raw: Record<string, unknown>): BoardPanel {
  return parseBoard({ panels: [{ id: "u", ...raw }] })!.panels[0]!;
}

// The Ops board on logs.example.org (sheet 50, 50d → 50e).
const eleos = parseBoard({
  panels: [
    { id: "u", name: "Graphs", view: "section", widget: { x: 0, y: 0, w: 12, h: 1 } },
    { id: "v", name: "Volume", q: "service:payroll", view: "histogram", widget: { x: 0, y: 1, w: 5, h: 4, split: "level" } },
    { id: "w", name: "Volume", q: "", view: "histogram", widget: { x: 5, y: 1, w: 5, h: 4, split: "level" } },
    { id: "x", name: "Metrics", view: "section", widget: { x: 0, y: 5, w: 12, h: 1 } },
    { id: "y", name: "rate", q: "service:queue", view: "stat", widget: { x: 0, y: 6, w: 3, h: 2, agg: "sum:queue.call.duration" } },
    { id: "z", name: "rate", q: "service:queue", view: "stat", widget: { x: 3, y: 6, w: 3, h: 2, agg: "rate" } },
    { id: "a", name: "rate", q: "service:queue level:warn", view: "stat", widget: { x: 6, y: 6, w: 3, h: 2, agg: "rate" } },
  ],
})!;

describe("panels named from their query (50e)", () => {
  test("the Ops board reads as the frame names it", () => {
    expect(eleos.panels.map(panelDisplayName)).toEqual([
      "Graphs",
      "payroll volume",
      "All logs",
      "Metrics",
      "queue call time",
      "queue rate",
      "queue warn rate",
    ]);
  });

  test("a name someone gave is kept", () => {
    expect(panelDisplayName(panel({ name: "API errors", q: "service:api level:error", view: "histogram", widget: {} }))).toBe("API errors");
    expect(panelDisplayName(panel({ name: "Checkout rate", q: "service:checkout", view: "stat", widget: { agg: "rate" } }))).toBe("Checkout rate");
    expect(isGenericPanelName(panel({ name: "Volume", q: "", view: "histogram", widget: {} }))).toBe(true);
    // A widget title is a name someone gave.
    expect(isGenericPanelName(panel({ name: "Volume", q: "service:api", view: "histogram", widget: { title: "Volume" } }))).toBe(false);
  });

  test("the stored name is not rewritten", () => {
    const p = eleos.panels[4]!;
    expect(panelDisplayName(p)).toBe("queue call time");
    expect(p.name).toBe("rate");
  });

  test("the panel sheet starts with the derived name, so Update panel stores it", () => {
    const p = eleos.panels[5]!;
    const draft = draftOf(p, eleos.panels);
    expect(draft.name).toBe("queue rate");
    expect(fieldsOf(draft, p).name).toBe("queue rate");
    const named = panel({ name: "Checkout rate", q: "service:checkout", view: "stat", widget: { agg: "rate" } });
    expect(draftOf(named, [named]).name).toBe("Checkout rate");
  });

  test("service and level values; more than one joined", () => {
    expect(querySubject("service:queue")).toBe("queue");
    expect(querySubject("service:queue level:warn")).toBe("queue warn");
    expect(querySubject("level:error")).toBe("error");
    expect(querySubject("service:api OR service:web")).toBe("api/web");
    // A negated value names nothing; the query is short enough to be its own name.
    expect(querySubject("-service:queue")).toBe("-service:queue");
    expect(querySubject("status:500")).toBe("status:500");
    expect(querySubject("")).toBe("");
    expect(querySubject("   ")).toBe("");
  });

  test("a long or broken query names nothing, and the panel keeps its name", () => {
    expect(querySubject("status:500 path:/api/v1/checkout/confirm")).toBeNull();
    expect(querySubject("service:(")).toBeNull();
    expect(panelDisplayName(panel({ name: "Volume", q: "status:500 path:/api/v1/checkout/confirm", view: "histogram", widget: {} }))).toBe("Volume");
  });

  test("measure words, kept short", () => {
    expect(measureWords("rate")).toBe("rate");
    expect(measureWords("count")).toBe("count");
    expect(measureWords(null)).toBe("count");
    expect(measureWords("sum:payroll.call.duration")).toBe("payroll call time");
    expect(measureWords("sum:payroll.call.duration", "payroll")).toBe("call time");
    expect(measureWords("p99:payroll.call.duration", "payroll")).toBe("p99 call time");
    expect(measureWords("avg:duration_ms")).toBe("avg duration");
    expect(measureWords("sum:duration_ms")).toBe("sum duration");
    expect(measureWords("sum:bytes")).toBe("sum bytes");
    expect(measureWords("max:http.response.size")).toBe("max http response size");
    expect(fieldWords("payroll.call.duration")).toEqual({ words: "payroll call time", time: true });
    expect(fieldWords("payroll.call.duration", "payroll")).toEqual({ words: "call time", time: true });
    expect(fieldWords("http.server.duration", "api")).toEqual({ words: "http server time", time: true });
  });

  test("each view", () => {
    expect(derivedPanelName(panel({ name: "x", q: "service:queue", view: "histogram", widget: { agg: "p99:duration_ms" } }))).toBe("queue p99 duration");
    expect(derivedPanelName(panel({ name: "x", q: "", view: "stat", widget: { agg: "rate" } }))).toBe("All logs rate");
    expect(derivedPanelName(panel({ name: "x", q: "service:queue", view: "top", widget: { split: "host" } }))).toBe("queue top host");
    expect(derivedPanelName(panel({ name: "x", q: "", view: "top", widget: { split: "none", attr: "status" } }))).toBe("Top status");
    expect(derivedPanelName(panel({ name: "x", q: "service:queue", view: "events", widget: {} }))).toBe("queue events");
    expect(derivedPanelName(panel({ name: "x", q: "", view: "events", widget: {} }))).toBeNull();
    expect(derivedPanelName(panel({ name: "x", q: "service:queue", view: "histogram", widget: { metric: "cpu.usage" } }))).toBe("queue cpu.usage");
    expect(panelDisplayName(panel({ name: "Events", q: "", view: "events", widget: {} }))).toBe("Events");
    expect(panelDisplayName(panel({ name: "Top values", q: "service:web", view: "top", widget: { split: "level" } }))).toBe("web top level");
    expect(panelDisplayName(panel({ name: "Note", q: "", view: "note", widget: {}, text: "hi" }))).toBe("Note");
    expect(panelDisplayName(panel({ name: "Section", q: "", view: "section", widget: {} }))).toBe("Section");
  });
});
