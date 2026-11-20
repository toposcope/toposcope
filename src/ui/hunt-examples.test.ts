import { describe, expect, test } from "bun:test";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { markLaneName } from "./change-marks";
import { railNameRooms } from "./components/histogram-marks";
import { SearchQueryField, queryExamples } from "./components/search-query-field";

describe("the empty query box reads as an example (50i)", () => {
  const field = (value: string) =>
    renderToStaticMarkup(
      createElement(SearchQueryField, {
        value,
        onChange: () => {},
        onCommit: () => {},
        onClear: () => {},
        showFaults: false,
        onShowFaults: () => {},
        chipInField: true,
        onChipInField: () => {},
        fields: [],
        loadValues: async () => [],
        history: [],
        inputRef: createRef<HTMLInputElement>(),
      }),
    );

  test("empty, it says Search all logs with two example chips, and keeps the / hint", () => {
    const html = field("");
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(queryExamples).toEqual(["level:error", "service:api"]);
    expect(text).toContain("Search all logs, e.g. level:error service:api /");
    expect(html.match(/<button[^>]*border-dashed/g)?.length).toBe(2);
    expect(text).not.toContain("level:fatal");
  });

  test("with a query, no examples", () => {
    expect(field("service:billing")).not.toContain("Search all logs");
  });
});

describe("every mark under the plot has a name (50i)", () => {
  test("a mark's lane name is its title, short", () => {
    expect(markLaneName({ kind: "deploy", service: "toposcope", title: "Toposcope 0.15.5 → 0.15.6" })).toBe("Toposcope 0.15.6");
    expect(markLaneName({ kind: "deploy", service: "toposcope", title: "Toposcope 0.15.5 → 0.15.6 (rolled back)" })).toBe("Toposcope 0.15.6 (rolled back)");
    expect(markLaneName({ kind: "deploy", service: "billing", title: "v0.9" })).toBe("billing v0.9");
    expect(markLaneName({ kind: "deploy", service: "", title: "deploy b460b1a" })).toBe("deploy b460b1a");
    expect(markLaneName({ kind: "flag", service: "api", title: "new-checkout on" })).toBe("new-checkout on");
  });

  test("neighbouring names share the gap between them, and never meet", () => {
    const laneW = 1050;
    // 50i's lane: the upgrade at 37% and a deploy at 55% both show their names whole.
    const chips = [
      { frac: 0.37, name: "Toposcope 0.15.6" },
      { frac: 0.55, name: "deploy b460b1a" },
    ];
    const [up, deploy] = railNameRooms(chips, laneW);
    // 103px is what "Toposcope 0.15.6" measured in the app at text-sm.
    expect(up).toBeGreaterThanOrEqual(103);
    expect(deploy).toBe(Math.ceil(14 * 6.8));
    // Closer, both still named, cut to half the gap each, and the two chips do not overlap.
    const near = [
      { frac: 0.37, name: "Toposcope 0.15.6" },
      { frac: 0.52, name: "a much longer deploy name here" },
    ];
    const [a, b] = railNameRooms(near, laneW);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    const chipW = (room: number) => room + 72 + 12;
    expect(chipW(a!) / 2 + chipW(b!) / 2).toBeLessThanOrEqual((0.52 - 0.37) * laneW);
    // A short name leaves its side of the gap to a long one.
    const [long, short] = railNameRooms([{ frac: 0.37, name: "a much longer deploy name here" }, { frac: 0.52, name: "v2" }], laneW);
    expect(long).toBeGreaterThan(a!);
    expect(short).toBe(Math.ceil(2 * 6.8) >= 28 ? Math.ceil(2 * 6.8) : 0);
    // A fold of marks is never named.
    expect(railNameRooms([{ frac: 0.5, name: null }], laneW)).toEqual([0]);
  });
});
