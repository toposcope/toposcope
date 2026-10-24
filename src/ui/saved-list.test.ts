import { describe, expect, test } from "bun:test";
import type { AlertRule, SavedSearch } from "@/types";
import {
  clampSidebar,
  filterSaved,
  groupOpen,
  groupSaved,
  kindCounts,
  matchIn,
  namePrefix,
  narrowedNote,
  noMatchLine,
  savedKind,
} from "./saved-list";

// #168: agental's 22 saved searches all read "agental stranded: bo…" at 240 px.
let next = 0;
const saved = (name: string, extra: Partial<SavedSearch> = {}): SavedSearch => ({
  id: `s${++next}`,
  name,
  query: "",
  from_ts: null,
  to_ts: null,
  range: "1h",
  created_at: 1000 - next,
  ...extra,
});
const alert = (savedId: string): AlertRule =>
  ({ id: `a-${savedId}`, name: "watch", saved_search_id: savedId, threshold: 5 }) as AlertRule;
const panels = { logs: false, widgets: [{ id: "a", kind: "timeseries", metric: "agental.box.disk", replaceY: true }] } as unknown as SavedSearch["widgets"];

describe("names that share the words before a colon", () => {
  test("a name splits at its first colon when both sides have words", () => {
    expect(namePrefix("agental stranded: box ended · vCPU")).toEqual({ prefix: "agental stranded", rest: "box ended · vCPU" });
    expect(namePrefix("Checkout errors")).toBeNull();
    expect(namePrefix(": nothing before")).toBeNull();
    expect(namePrefix("nothing after:")).toBeNull();
    expect(namePrefix("archive · azure-01 · Disk · removed 2026-10-23")).toEqual({ prefix: "archive", rest: "azure-01 · Disk · removed 2026-10-23" });
    expect(namePrefix("Shapes · CPU")).toEqual({ prefix: "Shapes", rest: "CPU" });
    expect(namePrefix("a·b")).toBeNull();
  });

  test("names joined by ` · ` group too: agental's own list (0.7.0)", () => {
    const names = [
      "Toposcope update", "archive · azure-01 · Disk · removed 2026-10-23", "archive · azure-01 · Memory · removed 2026-10-23",
      "archive · azure-01 · vCPU · removed 2026-10-23", "Disk · ovh-01", "Memory · ovh-01", "archive · env · Disk · removed 2026-10-22",
      "archive · env · Memory · removed 2026-10-22", "archive · env · vCPU · removed 2026-10-22", "Disk · all boxes",
      "Shapes · disk", "Shapes · memory", "Shapes · CPU",
    ];
    const groups = groupSaved(names.map((n) => saved(n))).filter((e) => e.type === "group");
    expect(groups.map((g) => [g.prefix, g.type === "group" ? g.rows.length : 0])).toEqual([
      ["archive", 6],
      ["Shapes", 3],
    ]);
  });

  test("three or more fold into a group named by those words, and their rows drop them", () => {
    const items = [
      saved("Checkout errors"),
      saved("agental stranded: box ended · vCPU"),
      saved("agental stranded: box ended · memory"),
      saved("agental stranded: box ended · disk"),
      saved("billing: invoices"),
      saved("billing: refunds"),
    ];
    const entries = groupSaved(items);
    expect(entries.map((e) => (e.type === "row" ? e.row.text : `[${e.prefix}] ${e.rows.map((r) => r.text).join(" | ")}`))).toEqual([
      "Checkout errors",
      "billing: invoices",
      "billing: refunds",
      "[agental stranded] box ended · vCPU | box ended · memory | box ended · disk",
    ]);
  });

  test("searches outside a group come first; groups follow in the order of their newest search", () => {
    const items = [
      saved("fleet: a"),
      saved("alert: a"),
      saved("Prod 5xx"),
      saved("alert: b"),
      saved("fleet: b"),
      saved("alert: c"),
      saved("fleet: c"),
    ];
    const entries = groupSaved(items);
    expect(entries.map((e) => (e.type === "row" ? e.row.text : e.prefix))).toEqual(["Prod 5xx", "fleet", "alert"]);
  });
});

describe("what each item is", () => {
  test("a board, a watched search, a search kept for its panels, a plain one", () => {
    const board = saved("Customer drill-down", { board: { keys: ["customer"], win: true } });
    const watched = saved("Prod 5xx");
    const kept = saved("vCPU · all boxes", { widgets: panels });
    const plain = saved("Checkout errors");
    const alerts = [alert(watched.id)];
    expect([board, watched, kept, plain].map((item) => savedKind(item, alerts))).toEqual(["board", "watched", "panels", null]);
  });

  test("a watched search kept for its panels shows the bell", () => {
    const both = saved("Disk alert", { widgets: panels });
    expect(savedKind(both, [alert(both.id)])).toBe("watched");
  });

  test("the kind buttons count only the kinds the list has", () => {
    const items = [saved("a", { widgets: panels }), saved("b", { widgets: panels }), saved("c")];
    expect(kindCounts(items, (item) => savedKind(item, [alert(items[2]!.id)]))).toEqual([
      { kind: "watched", n: 1 },
      { kind: "panels", n: 2 },
    ]);
  });
});

describe("the filter", () => {
  const items = [
    saved("agental stranded: box ended · vCPU"),
    saved("agental stranded: all boxes · vCPU"),
    saved("agental alert: API errors", { query: "box en" }),
  ];
  const none = () => null;

  test("it reads whole names, the shared words included, and ignores case", () => {
    expect(filterSaved(items, "box en", null, none).map((item) => item.name)).toEqual(["agental stranded: box ended · vCPU"]);
    expect(filterSaved(items, "STRANDED", null, none)).toHaveLength(2);
  });

  test("it never reads a query", () => {
    expect(filterSaved(items, "box en", null, none).some((item) => item.name.includes("API"))).toBe(false);
  });

  test("a kind button and the filter combine", () => {
    const kindOf = (item: SavedSearch) => (item.name.includes("alert") ? "watched" : null);
    expect(filterSaved(items, "agental", "watched", kindOf).map((item) => item.name)).toEqual(["agental alert: API errors"]);
  });

  test("the match is found where it is, to mark it", () => {
    expect(matchIn("box ended · vCPU", "BOX EN")).toEqual({ start: 0, end: 6 });
    expect(matchIn("box ended · vCPU", "  ")).toBeNull();
  });

  test("the line under the field, and what Saved says when nothing is left", () => {
    expect(narrowedNote(3, 22, null, "box en")).toBe("3 of 22");
    expect(narrowedNote(7, 22, "watched", "")).toBe("7 of 22 · watched by an alert");
    expect(narrowedNote(22, 22, null, " ")).toBeNull();
    expect(noMatchLine("invoices", null)).toBe("No saved search has “invoices” in its name.");
    expect(noMatchLine("invoices", "watched")).toBe("No watched saved search has “invoices” in its name.");
  });
});

describe("groups open and closed", () => {
  test("they start open, and closed past 20 saved searches; what was chosen wins", () => {
    expect(groupOpen("agental alert", 20, {})).toBe(true);
    expect(groupOpen("agental alert", 22, {})).toBe(false);
    expect(groupOpen("agental alert", 22, { "agental alert": true })).toBe(true);
    expect(groupOpen("agental alert", 5, { "agental alert": false })).toBe(false);
  });
});

describe("the sidebar's width", () => {
  test("it stays between 240 and 400", () => {
    expect(clampSidebar(100, 240, 1200)).toBe(240);
    expect(clampSidebar(520, 240, 1200)).toBe(400);
    expect(clampSidebar(360, 240, 1200)).toBe(360);
  });

  test("it stops where the plot would get narrower than 640", () => {
    // At 240 the plot has 700: the sidebar can take 60 more.
    expect(clampSidebar(400, 240, 700)).toBe(300);
    // A plot already under 640 never makes the sidebar narrower than 240.
    expect(clampSidebar(400, 240, 600)).toBe(240);
    // Narrowing is always allowed.
    expect(clampSidebar(260, 300, 600)).toBe(260);
  });
});
