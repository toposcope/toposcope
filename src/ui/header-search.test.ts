import { describe, expect, test } from "bun:test";
import { headerSuggestions, suggestionOrder } from "./header-search";
import type { SavedSearch } from "./types";

const hunt = (name: string): SavedSearch => ({ id: name, name }) as SavedSearch;
const board = (name: string): SavedSearch => ({ id: name, name, board: { keys: [] as string[], panels: [] } }) as unknown as SavedSearch;

describe("the header field's suggestions (49b)", () => {
  const saved = [hunt("API event loop stalls"), hunt("Starts slow"), board("Eleos"), hunt("Backup silent"), board("API latency"), hunt("rapid API errors")];

  test("nothing typed, nothing suggested", () => {
    expect(headerSuggestions(saved, "  ")).toEqual({ hunts: [], boards: [] });
  });

  test("hunts and boards by name, any case, every word held", () => {
    const s = headerSuggestions(saved, "api");
    expect(s.hunts.map((x) => x.name)).toEqual(["API event loop stalls", "rapid API errors"]);
    expect(s.boards.map((x) => x.name)).toEqual(["API latency"]);
    expect(headerSuggestions(saved, "loop api").hunts.map((x) => x.name)).toEqual(["API event loop stalls"]);
    expect(headerSuggestions(saved, "service:api")).toEqual({ hunts: [], boards: [] });
  });

  test("names that start with it come first, then a word that starts with it", () => {
    const list = [hunt("slow starts"), hunt("Starts slow"), hunt("restarts")];
    expect(headerSuggestions(list, "starts").hunts.map((x) => x.name)).toEqual(["Starts slow", "slow starts", "restarts"]);
  });

  test("a few of each, and the arrows walk hunts then boards", () => {
    const many = Array.from({ length: 9 }, (_, i) => hunt(`api ${i}`));
    const s = headerSuggestions([...many, board("api board")], "api", 3);
    expect(s.hunts.length).toBe(3);
    expect(suggestionOrder(s).map((x) => x.name)).toEqual(["api 0", "api 1", "api 2", "api board"]);
  });
});
