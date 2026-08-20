import { describe, expect, test } from "bun:test";
import {
  arrowUpOpensHistory,
  caretWord,
  historyHighlight,
  qualifierMenuKind,
} from "./search-menu";

describe("caretWord", () => {
  test("empty caret at the start of a query", () => {
    expect(caretWord("service:worker", 0)).toEqual({
      word: "",
      start: 0,
      colonAt: -1,
      openQuote: false,
    });
  });

  test("kv token at the end", () => {
    const q = "service:worker host:worker-2";
    expect(caretWord(q, q.length)).toEqual({
      word: "host:worker-2",
      start: "service:worker ".length,
      colonAt: 4,
      openQuote: false,
    });
  });
});

describe("qualifierMenuKind", () => {
  test("history wins over an auto-open value menu", () => {
    expect(
      qualifierMenuKind({
        focus: true,
        muted: false,
        openQuote: false,
        word: "host:worker-2",
        colonAt: 4,
        forceFields: false,
        wantHistory: true,
        hasHistory: true,
      }),
    ).toBe("history");
  });

  test("value after key: when not asking for history", () => {
    expect(
      qualifierMenuKind({
        focus: true,
        muted: false,
        openQuote: false,
        word: "host:w",
        colonAt: 4,
        forceFields: false,
        wantHistory: false,
        hasHistory: true,
      }),
    ).toBe("value");
  });
});

describe("arrowUpOpensHistory", () => {
  test("↑ with no highlight opens history even on a kv token", () => {
    expect(
      arrowUpOpensHistory({
        openQuote: false,
        hasHistory: true,
        menuSel: -1,
        menuKind: "value",
      }),
    ).toBe(true);
  });

  test("↑ navigates once a row is highlighted", () => {
    expect(
      arrowUpOpensHistory({
        openQuote: false,
        hasHistory: true,
        menuSel: 0,
        menuKind: "value",
      }),
    ).toBe(false);
  });

  test("↑ navigates inside history", () => {
    expect(
      arrowUpOpensHistory({
        openQuote: false,
        hasHistory: true,
        menuSel: -1,
        menuKind: "history",
      }),
    ).toBe(false);
  });
});

describe("historyHighlight", () => {
  test("skips the query still in the bar", () => {
    expect(historyHighlight(["a", "b"], "a")).toBe(1);
    expect(historyHighlight(["a"], "a")).toBe(0);
  });
});
