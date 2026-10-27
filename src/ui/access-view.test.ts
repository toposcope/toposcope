import { describe, expect, test } from "bun:test";
import type { AccessRow } from "../access/list";
import { accessGlyph, accessGroups, expiryWords, inFilter } from "./components/access-view";

const now = Date.parse("2026-10-26T13:26:00Z");
const row = (over: Partial<AccessRow>): AccessRow => ({
  kind: "token", verb: "token", direction: "in", id: "x", name: "x", lets_through: "", scope: "any", expires_at: null, last_used_at: null, today: { used: 0, refused: 0 }, revoke: null, open: null, made_by: null, ...over,
});

describe("Access (#265, 26i; the one door, 29a, #295)", () => {
  test("expiry in words; a share under 14 days asks to be renewed", () => {
    expect(expiryWords(row({}), now)).toEqual({ text: "never expires", soon: false });
    expect(expiryWords(row({ kind: "link", verb: "we copy from" }), now)).toEqual({ text: "—", soon: false });
    expect(expiryWords(row({ kind: "invite", verb: "key not used yet", direction: "out" }), now)).toEqual({ text: "once pasted", soon: false });
    expect(expiryWords(row({ kind: "share", verb: "share", direction: "out", expires_at: now + 12 * 86_400_000 }), now)).toEqual({ text: "in 12 d", soon: true });
    expect(expiryWords(row({ kind: "share", verb: "share", direction: "out", expires_at: now + 341 * 86_400_000 }), now)).toEqual({ text: "in 341 d", soon: false });
  });
  test("filters: tokens, links with their keys, shares", () => {
    expect(inFilter(row({}), "tokens")).toBe(true);
    expect(inFilter(row({ kind: "invite", verb: "key not used yet" }), "links")).toBe(true);
    expect(inFilter(row({}), "links")).toBe(false);
    expect(inFilter(row({ kind: "share", verb: "share" }), "shares")).toBe(true);
  });
  test("groups are Tokens, Links, Shares in that order", () => {
    expect(accessGroups.map((g) => g.title)).toEqual(["Tokens", "Links", "Shares"]);
  });
  test("the chip's arrow says which way rows move", () => {
    expect(accessGlyph(row({})).glyph).toBe("↓");
    expect(accessGlyph(row({ kind: "link", direction: "in" })).glyph).toBe("←");
    expect(accessGlyph(row({ kind: "link", direction: "out" })).glyph).toBe("→");
    expect(accessGlyph(row({ kind: "invite", direction: "out" })).glyph).toBe("→");
    expect(accessGlyph(row({ kind: "share", direction: "out" })).glyph).toBe("↑");
  });
});
