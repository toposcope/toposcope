import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { boardPaletteDetail } from "./command-palette";
import { looksLikeQuery, paletteRows, type PaletteItem } from "./components/command-palette";

// Sheet 45, Command palette (#447).
const noop = () => {};
const items: PaletteItem[] = [
  { group: "Go to", label: "Home", run: noop },
  { group: "Saved hunts", label: "checkout 5xx", detail: "service:checkout status:5*", run: noop },
  { group: "Boards", label: "billing on call", detail: "4 panels · host", run: noop },
  { group: "Actions", label: "New hunt tab", run: noop },
];

describe("command palette", () => {
  test("groups in order: saved hunts, boards, go to, actions", () => {
    expect(paletteRows(items, "", noop).map((r) => r.group)).toEqual(["Saved hunts", "Boards", "Go to", "Actions"]);
  });

  test("typing filters names and queries", () => {
    expect(paletteRows(items, "bill", noop).map((r) => r.label)).toEqual(["billing on call", "Hunt for"]);
    expect(paletteRows(items, "checkout", noop)[0]!.label).toBe("checkout 5xx");
  });

  test("a query puts Hunt for first; other text puts it last", () => {
    expect(looksLikeQuery("status:5*")).toBe(true);
    expect(looksLikeQuery("billing")).toBe(false);
    const hunted: string[] = [];
    const rows = paletteRows(items, "status:5*", (q) => hunted.push(q));
    expect(rows[0]).toMatchObject({ label: "Hunt for", detail: "status:5*" });
    expect(rows[1]!.label).toBe("checkout 5xx");
    rows[0]!.run();
    expect(hunted).toEqual(["status:5*"]);
    expect(paletteRows(items, "home", noop).at(-1)!.label).toBe("Hunt for");
  });

  test("a board's row names its panels and inputs", () => {
    expect(boardPaletteDetail({ keys: ["host"], panels: new Array(4).fill(null) as never })).toBe("4 panels · host");
    expect(boardPaletteDetail({ keys: [], panels: [null] as never })).toBe("1 panel");
  });

  test("⌘K or Ctrl K opens it from any page; / still focuses the query bar", () => {
    const app = readFileSync("src/ui/App.tsx", "utf8");
    expect(app).toMatch(/e\.metaKey \|\| e\.ctrlKey\)[^\n]*e\.key\.toLowerCase\(\) === "k"/);
    expect(app).toMatch(/e\.key === "\/" && !isTypingTarget/);
  });
});
