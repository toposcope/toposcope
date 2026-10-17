import { describe, expect, test } from "bun:test";
import { decodeLinkKey, encodeLinkKey, hashSecret, kidLabel, linkKeyNotAKey, newKid, newSecret } from "./key";
import { keyState, type LinkKeyRecord } from "./store";

describe("link keys (#136)", () => {
  const key = {
    kind: "offer" as const,
    name: "edge-fra",
    url: "https://edge-fra.internal:8080",
    kid: "k7f3a",
    q: "level:error service:api checkout",
    until: null,
    secret: newSecret(),
  };

  test("round trip: the prefix says the direction, the rest the minter, the filter and the date", () => {
    const text = encodeLinkKey(key);
    expect(text.startsWith("tsl1_o.")).toBe(true);
    expect(text).not.toContain(" ");
    expect(decodeLinkKey(text)).toEqual(key);
    const invite = encodeLinkKey({ ...key, kind: "invite", q: "", until: Date.parse("2026-10-20T00:00:00Z") });
    expect(invite.startsWith("tsl1_i.")).toBe(true);
    expect(decodeLinkKey(invite)).toEqual({ ...key, kind: "invite", q: "", until: Date.parse("2026-10-20T00:00:00Z") });
  });

  test("anything else is not a link key, and says so without guessing a direction", () => {
    expect(decodeLinkKey("Bearer 9f2c1e7a0b44d6")).toEqual({ error: linkKeyNotAKey });
    expect(decodeLinkKey(encodeLinkKey(key).replace("tsl1_o", "tsl1_x"))).toEqual({ error: linkKeyNotAKey });
    expect(decodeLinkKey(encodeLinkKey({ ...key, url: "ftp://edge" }))).toEqual({ error: linkKeyNotAKey });
    const text = encodeLinkKey(key);
    // Cut short: a segment is missing.
    expect(decodeLinkKey(text.slice(0, text.lastIndexOf(".")))).toEqual({ error: linkKeyNotAKey });
  });

  test("ids and secrets", () => {
    expect(newKid()).toMatch(/^k[0-9a-f]{4}$/);
    expect(kidLabel("k7f3a")).toBe("k-7f3a");
    expect(newSecret()).not.toBe(newSecret());
    expect(hashSecret("a")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("where a key stands", () => {
    const base: LinkKeyRecord = { kid: "k1234", kind: "offer", q: "", secret_hash: "x", until: null, uses: 0, created_at: 0, spent_at: null, revoked_at: null };
    expect(keyState(base)).toBe("unused");
    expect(keyState({ ...base, spent_at: 5, uses: 1 })).toBe("used");
    expect(keyState({ ...base, revoked_at: 5 })).toBe("revoked");
    expect(keyState({ ...base, until: 100, uses: 3 }, 50)).toBe("unused");
    expect(keyState({ ...base, until: 100 }, 150)).toBe("expired");
  });
});
