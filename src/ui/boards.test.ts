import { describe, expect, test } from "bun:test";
import {
  BOARD_MAX,
  bindForBoard,
  boardWatchRefuse,
  boundQuery,
  isBoardUnbound,
  parseBoard,
  storedBoardQuery,
} from "./boards";

describe("parseBoard", () => {
  test("reads keys and window, drops junk, caps at 4", () => {
    expect(parseBoard({ keys: ["install_name"], win: true })).toEqual({
      keys: ["install_name"],
      win: true,
    });
    expect(parseBoard({ keys: ["level", "service", "host", "status", "path"], win: true })).toEqual({
      keys: ["level", "service", "host"],
      win: true,
    });
    expect(parseBoard({ keys: [], win: false })).toBeNull();
    expect(BOARD_MAX).toBe(4);
  });
});

describe("bindings", () => {
  test("unbound until every field slot has a value", () => {
    const board = { keys: ["install_name"], win: true };
    expect(isBoardUnbound(board, {})).toBe(true);
    expect(isBoardUnbound(board, { install_name: "acme-eu" })).toBe(false);
  });

  test("bindForBoard keeps only that board's slot keys", () => {
    expect(
      bindForBoard({ install_name: "acme-eu", q: "nope", status: "500" }, [
        "install_name",
      ]),
    ).toEqual({ install_name: "acme-eu" });
  });

  test("extract-on-save lifts slotted tokens; boundQuery ANDs them back", () => {
    const stored = storedBoardQuery(
      "level:warn install_name:acme-eu status:4*",
      ["install_name"],
    );
    expect(stored).toBe("level:warn status:4*");
    expect(boundQuery(stored, { install_name: "acme-eu" })).toBe(
      "level:warn status:4* install_name:acme-eu",
    );
  });

  test("watch refuse names the holes", () => {
    expect(
      boardWatchRefuse({
        query: "level:warn status:4*",
        range: "4h",
        board: { keys: ["install_name"], win: true },
      }),
    ).toContain("install_name unset");
  });
});
