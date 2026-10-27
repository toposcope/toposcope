import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccessRow } from "../access/list";
import { AccessView, accessGlyph, accessGroups, expiryWords, inFilter, kindsById, LetSomeoneIn, whatLeaves } from "./components/access-view";
import { KindBoxes, KindChips } from "./components/kind-boxes";
import type { LinkItem, LinkKeyItem } from "./link-words";

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

describe("Access names the kinds a link carries (#329, 33c)", () => {
  const noop = () => undefined;
  const item = (over: Partial<LinkItem>): LinkItem => ({
    id: "l_1", role: "serve", connects: "they", peer_id: "p", peer_name: "ian-laptop", peer_url: "http://x", q: "", kinds: "logs,marks,traces,metrics,profiles,monitors",
    kid: "k1", position: 0, settled: 0, arrived_at: null, behind_rows: null, gone_from: null, gone_to: null, gone_from_at: null, gone_to_at: null,
    last_contact_at: null, last_error: null, created_at: 0, ...over,
  });
  const key = (over: Partial<LinkKeyItem>): LinkKeyItem => ({ kid: "k2d18", label: "k-2d18", kind: "offer", q: "", kinds: ["logs", "marks"], until: null, uses: 0, created_at: 0, ...over });

  test("kinds by link id and by key kid", () => {
    const by = kindsById({ links: [item({ kinds: "traces,logs" })], keys: [key({})] });
    expect(by.get("l_1")).toEqual({ q: "", kinds: ["logs", "traces"] });
    expect(by.get("k2d18")?.kinds).toEqual(["logs", "marks"]);
    expect(kindsById(null).size).toBe(0);
  });

  test("What leaves this instance names exactly the ticked kinds, links that copy from us and offer keys only", () => {
    const words = whatLeaves(
      {
        links: [item({ q: "level:error OR level:fatal", kinds: "logs,marks,traces,metrics,profiles,monitors" }), item({ id: "l_2", role: "pull", peer_name: "edge-1" })],
        keys: [key({ q: "service:api*" }), key({ kid: "k9", label: "k-9", kind: "invite" })],
      },
      [row({ kind: "share", name: "agental-admin" })],
    );
    expect(words).toBe(
      "ian-laptop copies logs and marks matching level:error OR level:fatal from us; no spans, points, profiles or monitors, because its scope names level. " +
        "Once key k-2d18 is pasted, whoever pasted it will copy logs and marks matching service:api* from us; no spans, points, profiles or monitors, unticked. " +
        "agental-admin reads counts, never a row.",
    );
    expect(whatLeaves({ links: [], keys: [] }, [])).toBe("Nothing: no link copies from this instance and no share reads from it.");
  });

  test("chips: a kind that goes, one the scope rules out, one unticked", () => {
    const html = renderToStaticMarkup(createElement(KindChips, { q: "level:error", kinds: ["logs", "marks", "traces"] }));
    expect(html).toContain(">logs<");
    expect(html).toContain("traces · scope names level");
    expect(html).toContain("metrics unticked");
  });

  test("the boxes are real checkboxes with labels, all six, the ones the scope rules out disabled with why", () => {
    const html = renderToStaticMarkup(createElement(KindBoxes, { q: "host:edge-2* level:error", ticked: ["logs", "marks", "traces", "metrics", "profiles", "monitors"], onChange: noop, legend: "What leaves" }));
    expect(html.match(/<label/g)?.length).toBe(6);
    expect(html.match(/type="checkbox"/g)?.length).toBe(6);
    expect(html.match(/disabled=""/g)?.length).toBe(4);
    expect(html).toContain("What leaves · 2 of 6 with this scope");
    expect(html).toContain('not sent: the scope names <span class="font-mono">level</span>, which spans do not have');
    expect(html).toContain("not sent: they go with their spans, and no spans go");
  });

  test("on a link already made, a kind it never carried cannot be ticked", () => {
    const html = renderToStaticMarkup(createElement(KindBoxes, { q: "", ticked: ["logs"], onChange: noop, legend: "What leaves", allowed: ["logs", "marks"] }));
    expect(html.match(/disabled=""/g)?.length).toBe(4);
    expect(html).toContain("never sent on this link · make a new key to send it");
    expect(html).toContain("unticked · not sent");
  });
});
