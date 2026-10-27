import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccessRow } from "../access/list";
import { AccessView, accessGlyph, accessGroups, expiryWords, inFilter, LetSomeoneIn } from "./components/access-view";

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

describe("Links makes a key as well as pasting one", () => {
  const noop = () => undefined;
  const view = (filter: "all" | "links", role: "owner" | "operator" = "owner") =>
    renderToStaticMarkup(
      createElement(AccessView, { filter, onFilter: noop, here: null, retentionDays: 30, onOpenHunt: noop, onOpenLink: noop, onOpenShare: noop, onNewShare: noop, me: { id: "p1", name: "Maya K.", role } }),
    );
  test("an Owner's Links group shows Make a link key beside Paste a link key, under All while empty and under Links", () => {
    for (const filter of ["all", "links"] as const) {
      const html = view(filter);
      expect(html).toContain('aria-label="Links"');
      expect(html).toContain("Make a link key");
      expect(html).toContain("Paste a link key");
      expect(html.indexOf("Make a link key")).toBeLessThan(html.indexOf("Paste a link key"));
    }
  });
  test("an Operator's Links group offers neither, as 0.9 has it for Paste a link key", () => {
    const html = view("links", "operator");
    expect(html).toContain('aria-label="Links"');
    expect(html).not.toContain("Make a link key");
    expect(html).not.toContain("Paste a link key");
  });
  test("Make a link key opens Let someone in on Link, with the way to choose and the key hint", () => {
    const html = renderToStaticMarkup(createElement(LetSomeoneIn, { initial: "link", onClose: noop, onToken: noop, onLink: noop, onShare: noop }));
    expect(html).toContain("Which way");
    expect(html).toContain("They copy from us · rows leave here");
    expect(html).toContain("We copy from them · rows come here");
    expect(html).toContain("Choose the scope and make the key");
    expect(html).toContain("appears under Links as key not used yet until the other side pastes it");
  });
  test("the top door still opens on no kind", () => {
    const html = renderToStaticMarkup(createElement(LetSomeoneIn, { onClose: noop, onToken: noop, onLink: noop, onShare: noop }));
    expect(html).not.toContain("Which way");
  });
});
