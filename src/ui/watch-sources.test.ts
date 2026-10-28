import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { HeldSource } from "../shared/held";
import { SourceDetail, WatchView } from "./components/watch-view";
import type { MonitorsFromSource, MonitorsResponse, PushResultRow, SourceMonitor } from "./types";
import {
  placeShows,
  sourceDefinition,
  sourceKindWords,
  sourceRow,
  sourceStanding,
  sourceStretch,
  watchFilters,
  watchPlaces,
  watchSummary,
} from "./watch";

const now = Date.UTC(2026, 9, 27, 13, 25);
const hour = 60 * 60_000;
const from = now - 24 * hour;

function def(over: Partial<SourceMonitor> = {}): SourceMonitor {
  return {
    id: "m1",
    name: "api.edge-1.example.io",
    kind: "threshold",
    source: "http",
    state: "ok",
    enabled: 1,
    threshold: 0,
    opens_when: "at_least",
    every_ms: 30_000,
    grace_ms: null,
    last_result: "ok",
    last_value: null,
    last_result_at: now - 60_000,
    service: "api",
    host: "api.edge-1.example.io",
    ...over,
  };
}

function result(over: Partial<PushResultRow> = {}): PushResultRow {
  return { id: 1, monitor_id: "m1", at: now - 60_000, result: "ok", exit_code: null, duration_ms: 212, value: null, unit: null, message: "200", host: "", via: "", ...over };
}

const caughtUp: HeldSource = { name: "edge-1", filters: [], state: { kind: "caught-up" }, hole: null };
const behind: HeldSource = { name: "edge-2", filters: [], state: { kind: "behind", readTo: now - 13 * 60_000 }, hole: null };

describe("a source's monitors on Watch (#333, 33g)", () => {
  const sources: MonitorsFromSource[] = [
    { source: "edge-1", at: now, monitors: [def(), def({ id: "m2" }), def({ id: "m3" })], stretches: [] },
    { source: "edge-2", at: now, monitors: [def({ id: "m4" }), def({ id: "m5", source: "cert" })], stretches: [] },
  ];

  test("the place segment is All · Here · each source, and none without sources", () => {
    expect(watchPlaces(2, sources)).toEqual([
      { id: "all", label: "All", n: 7 },
      { id: "here", label: "Here", n: 2 },
      { id: "from:edge-1", label: "edge-1", n: 3 },
      { id: "from:edge-2", label: "edge-2", n: 2 },
    ]);
    expect(watchPlaces(2, [])).toEqual([]);
    expect(placeShows("all", null)).toBe(true);
    expect(placeShows("here", null)).toBe(true);
    expect(placeShows("here", "edge-1")).toBe(false);
    expect(placeShows("from:edge-1", "edge-1")).toBe(true);
    expect(placeShows("from:edge-1", "edge-2")).toBe(false);
    expect(placeShows("from:edge-1", null)).toBe(false);
  });

  test("the header counts here and from the linked instances", () => {
    expect(watchSummary(2, sources)).toBe("7 monitors · 2 here, 5 from 2 linked instances");
    expect(watchSummary(1, [])).toBe("1 monitor");
    expect(watchSummary(0, [sources[1]!])).toBe("2 monitors · 0 here, 2 from 1 linked instance");
  });

  test("the kind segment counts a source's monitors too", () => {
    const f = watchFilters([{ source: "search", kind: "threshold" }, ...sources.flatMap((s) => s.monitors)]);
    expect(f).toEqual([
      { id: "all", label: "All", n: 6 },
      { id: "search", label: "Search", n: 1 },
      { id: "http", label: "HTTP", n: 4 },
      { id: "cert", label: "Certificate", n: 1 },
    ]);
  });

  test("a caught-up source says so; a short one says since when and hatches to now", () => {
    const ok = sourceStanding("edge-1", caughtUp, now, from, now, now);
    expect(ok.short).toBe(false);
    expect(ok.line).toContain("caught up");
    expect(ok.hatches).toEqual([]);
    const short = sourceStanding("edge-2", behind, now, from, now, now);
    expect(short.short).toBe(true);
    expect(short.since).toBe(now - 13 * 60_000);
    expect(short.line).toBe("short since 13:12 · results after that are not here yet");
    expect(short.hatches).toHaveLength(1);
    expect(short.hatches[0]!.left + short.hatches[0]!.width).toBeCloseTo(1, 6);
    expect(short.hatches[0]!.left).toBeCloseTo(1 - 13 / (24 * 60), 6);
  });

  test("a source with no pull link now is not called short, and says when it was copied", () => {
    const gone = sourceStanding("edge-3", undefined, now - 2 * hour, from, now, now);
    expect(gone.short).toBe(false);
    expect(gone.line).toBe("judged and called at edge-3 · copied here 11:25, no link from it now");
  });

  test("a row of a short source is never green: grey dot, the last result here, Now a question", () => {
    const row = sourceRow(def(), "edge-2", [], [result({ at: now - 13 * 60_000 })], { short: true }, now);
    expect(row.dot).toBe("paused");
    expect(row.line).toBe("ok at 13:12, the last result here");
    expect(row.now).toEqual({ text: "?", tone: "amber" });
    expect(row.lastCheck).toBe(now - 13 * 60_000);
  });

  test("an open stretch from the source shows open, red, with its time there", () => {
    const stretch = { id: "s1", monitor_id: "m1", opened_at: now - 34 * 60_000, resolved_at: null, closed_by: null, open_message: "500" };
    const row = sourceRow(def({ state: "open" }), "edge-1", [stretch], [result({ duration_ms: 48 })], { short: false }, now);
    expect(row.dot).toBe("open");
    expect(row.line).toBe("open at edge-1 since 12:51 · 34m");
    expect(row.now).toEqual({ text: "48 ms", tone: "red" });
    expect(row.open?.id).toBe("s1");
    expect(row.open?.calls).toEqual([]);
  });

  test("an ok row reads its last time; a push its value and unit; a search its count", () => {
    expect(sourceRow(def(), "edge-1", [], [result()], { short: false }, now)).toMatchObject({ dot: "ok", line: "ok", now: { text: "212 ms", tone: "sec" } });
    const push = def({ source: "push", every_ms: 86_400_000 });
    expect(sourceRow(push, "edge-1", [], [result({ value: 87.2, unit: "%" })], { short: false }, now).now.text).toBe("87.2 %");
    const search = def({ source: "search", last_value: 4, every_ms: null });
    expect(sourceRow(search, "edge-1", [], [], { short: false }, now).now.text).toBe("4");
    const warn = sourceRow(def({ last_result: "warn" }), "edge-1", [], [], { short: false }, now);
    expect(warn.dot).toBe("warn");
    expect(warn.now.tone).toBe("amber");
  });

  test("what a source's monitor checks, and its definition, from the definition alone", () => {
    expect(sourceKindWords(def())).toBe("url · every 30s");
    expect(sourceKindWords(def({ source: "tcp" }))).toBe("port · every 30s");
    expect(sourceKindWords(def({ source: "search", threshold: 5, every_ms: null }))).toBe("saved hunt · at least 5");
    const lines = sourceDefinition(def(), "edge-1");
    expect(lines[0]).toEqual({ label: "From", value: "edge-1, judged and called there" });
    expect(lines.map((l) => l.label)).toEqual(["From", "Checks", "Service", "Host", "Every", "State there"]);
  });

  test("a source's stretch fills nothing it was not sent", () => {
    const s = sourceStretch({ id: "s", monitor_id: "m", opened_at: 1, resolved_at: 5, closed_by: "ok", open_message: "x" });
    expect(s).toMatchObject({ opened_at: 1, resolved_at: 5, last_at: 5, open_call: null, resolved_call: null, calls: [] });
  });

  test("Watch draws Here, then each source read-only, with no Edit, Pause or Silence on its rows", () => {
    const data: MonitorsResponse = {
      now,
      from: new Date(from).toISOString(),
      to: new Date(now).toISOString(),
      monitors: [],
      stretches: [],
      sent: [],
      results: [result(), result({ id: 2, monitor_id: "m4", at: now - 20 * 60_000 })],
      sources: [
        { source: "edge-1", at: now, monitors: [def()], stretches: [] },
        { source: "edge-2", at: now, monitors: [def({ id: "m4", name: "billing-db:5432", source: "tcp" })], stretches: [] },
      ],
      link: false,
    };
    const html = renderToStaticMarkup(
      createElement(WatchView, {
        data,
        canCreate: true,
        range: "24h",
        onRange: () => {},
        filter: "all",
        onFilter: () => {},
        marks: [],
        onNew: () => {},
        onOpen: () => {},
        held: [caughtUp, behind],
        linked: new Set(["edge-1"]),
        onOpenLink: () => {},
      }),
    );
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text).toContain("2 monitors · 0 here, 2 from 2 linked instances");
    expect(text).toContain("All 2");
    expect(text).toContain("Here 0");
    expect(text).toContain("from edge-1");
    expect(text).toContain("from edge-2");
    expect(html.match(/read-only</g)?.length).toBe(2);
    expect(text).toContain("short since 13:12");
    // One link only: edge-2 has no pull link here.
    expect(html.match(/the link →/g)?.length).toBe(1);
    // The short source's lane is hatched; the caught-up one's is not.
    expect(html.match(/data-short/g)?.length).toBe(1);
    // Nothing in a source's group changes it: no Edit, Pause, Silence or delete.
    const groups = html.slice(html.indexOf("data-source-group"), html.lastIndexOf("</section>"));
    expect(groups.replace(/<[^>]+>/g, " ")).not.toMatch(/\bEdit\b|\bPause\b|\bSilence\b|\bDelete\b/);
    expect(groups).not.toContain("<button type=\"button\" aria-pressed");
  });

  test("opening a source's monitor shows its definition, results and stretches, and nothing to change", () => {
    const stretches = [
      { id: "s1", monitor_id: "m1", opened_at: now - 34 * 60_000, resolved_at: null, closed_by: null, open_message: "500 on /health" },
      { id: "s0", monitor_id: "m1", opened_at: now - 5 * hour, resolved_at: now - 4 * hour, closed_by: "ok" as const, open_message: "" },
    ];
    const html = renderToStaticMarkup(
      createElement(SourceDetail, { monitor: def(), source: "edge-1", stretches, results: [result({ result: "fail", message: "500" })], nowMs: now }),
    );
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text).toContain("Definition read-only");
    expect(text).toContain("edge-1, judged and called there");
    expect(text).toContain("13:24 fail 500");
    expect(text).toContain("open 34m · 500 on /health");
    expect(text).toContain("resolved 09:25 · 1h");
    expect(html).not.toContain("<button");
    expect(text).not.toMatch(/\bEdit\b|\bPause\b|\bSilence\b|\bDelete\b/);
  });
});
