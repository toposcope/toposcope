import { describe, expect, test } from "bun:test";
import type { AccessRow } from "../access/list";
import { expiryWords, inFilter, leavesWords } from "./components/access-view";

const now = Date.parse("2026-10-26T13:26:00Z");
const row = (over: Partial<AccessRow>): AccessRow => ({
  kind: "token", verb: "writes in", id: "x", name: "x", lets_through: "", scope: "any", expires_at: null, last_used_at: null, today: { used: 0, refused: 0 }, revoke: null, open: null, ...over,
});

describe("Access (#265, 26i)", () => {
  test("expiry in words; a share under 14 days asks to be renewed", () => {
    expect(expiryWords(row({}), now)).toEqual({ text: "never", soon: false });
    expect(expiryWords(row({ kind: "link", verb: "copies rows out" }), now)).toEqual({ text: "—", soon: false });
    expect(expiryWords(row({ kind: "invite", verb: "invite" }), now)).toEqual({ text: "once pasted", soon: false });
    expect(expiryWords(row({ kind: "share", verb: "reads aggregates", expires_at: now + 12 * 86_400_000 }), now)).toEqual({ text: "in 12 d", soon: true });
    expect(expiryWords(row({ kind: "share", verb: "reads aggregates", expires_at: now + 341 * 86_400_000 }), now)).toEqual({ text: "in 341 d", soon: false });
  });
  test("filters: writes in, links with their invites, shares", () => {
    expect(inFilter(row({ kind: "invite", verb: "invite" }), "links")).toBe(true);
    expect(inFilter(row({}), "links")).toBe(false);
    expect(inFilter(row({ kind: "share", verb: "reads aggregates" }), "shares")).toBe(true);
  });
  test("what leaves this instance, from the rows", () => {
    expect(leavesWords([row({ kind: "link", verb: "copies rows out", name: "here → ian-laptop", scope: "level:error" }), row({ kind: "share", verb: "reads aggregates" })])).toBe(
      "Raw rows go only to ian-laptop (level:error). Aggregates go to 1 share, never with an id in them. Nothing else reads out.",
    );
    expect(leavesWords([])).toBe("No raw rows leave this instance. No aggregates are read out. Nothing else reads out.");
  });
});
