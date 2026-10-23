import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrateControlDb } from "../control/index";
import { cacheMs, dropShareCache, readShareCache, shareCacheKey, writeShareCache } from "./cache";
import { defaultShareEmbed, embedFrameHeaders, mintTicket, parseOrigin, parseShareEmbed, ticketShareId, ticketShareRow } from "./embed";
import { embedLoader } from "./embed-page";
import { defaultShareLimits } from "./limits";
import { parseShareScope, type ShareScope } from "./scope";
import { putShare, revokeShare, shareSecretHash } from "./store";

const now = Date.parse("2026-10-23T12:00:00Z");
const day = 86_400_000;

function scope(): ShareScope {
  const parsed = parseShareScope({ metric_names: ["fleet_*"] });
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed;
}

describe("frame origins", () => {
  test("an origin and nothing more; never *", () => {
    expect(parseOrigin("https://admin.agental.dev")).toBe("https://admin.agental.dev");
    expect(parseOrigin("http://localhost:3000/")).toBe("http://localhost:3000");
    for (const bad of ["*", "https://*.example.com", "https://a.example.com/console", "ftp://a.example.com", "admin.example.com", "https://u:p@a.example.com"]) {
      expect(parseOrigin(bad)).toBeNull();
    }
    expect(parseShareEmbed({ frame_ancestors: ["https://a.example.com", "https://a.example.com"] })).toEqual({
      frame_ancestors: ["https://a.example.com"],
      ticket_ttl: "1h",
    });
    expect(parseShareEmbed({ ticket_ttl: "2d" })).toHaveProperty("error");
  });

  test("an embed is framed by its share's origins only; with none, by nobody", () => {
    expect(embedFrameHeaders(["https://a.example.com"])["content-security-policy"]).toBe("frame-ancestors https://a.example.com");
    expect(embedFrameHeaders([])["content-security-policy"]).toBe("frame-ancestors 'none'");
    expect(embedFrameHeaders([])["referrer-policy"]).toBe("no-referrer");
  });
});

describe("tickets", () => {
  test("a ticket reads until it runs out, and dies with its share", () => {
    const db = new Database(":memory:");
    migrateControlDb(db);
    const { share } = putShare({ name: "console", scope: scope(), limits: defaultShareLimits, embed: defaultShareEmbed, expires_at: now + day }, now, db);
    const hash = shareSecretHash(share.id, db)!;
    const { ticket, expires_at } = mintTicket(share, hash, "1h", now);
    expect(expires_at).toBe(now + 3_600_000);
    expect(ticketShareId(ticket)).toBe(share.id);
    expect(ticketShareRow(ticket, now + 1, db)?.id).toBe(share.id);
    expect(ticketShareRow(ticket, expires_at, db)).toBeNull();
    // A forged signature, or a later stop time under the old signature, opens nothing.
    expect(ticketShareRow(`${ticket.slice(0, -2)}xx`, now, db)).toBeNull();
    const [head, , sig] = ticket.split(".");
    expect(ticketShareRow(`${head}.${expires_at + day}.${sig}`, now, db)).toBeNull();
    revokeShare("console", now + 2, db);
    expect(ticketShareRow(ticket, now + 3, db)).toBeNull();
  });
});

describe("the answer cache", () => {
  test("an answer lasts to its next bar, at most 30s", () => {
    expect(cacheMs(now, 60_000)).toBe(30_000);
    expect(cacheMs(now + 50_000, 60_000)).toBe(10_000);
    expect(cacheMs(now + 59_900, 60_000)).toBe(1_000);
    expect(cacheMs(now)).toBe(30_000);
  });

  test("one key per panel however its query is ordered; a revoke drops the share's answers", () => {
    const key = shareCacheKey("/share/v1/series", { range: "24h", metric: "cpu" });
    expect(key).toBe(shareCacheKey("/share/v1/series", { metric: "cpu", range: "24h" }));
    writeShareCache("s1", key, { n: 1 }, 10_000, now);
    expect(readShareCache("s1", key, now + 9_999)?.body).toEqual({ n: 1 });
    expect(readShareCache("s1", key, now + 10_000)).toBeNull();
    writeShareCache("s1", key, { n: 2 }, 10_000, now);
    dropShareCache("s1");
    expect(readShareCache("s1", key, now)).toBeNull();
  });
});

describe("the script tag", () => {
  test("places the iframe and a fallback; it reads no data", () => {
    const js = embedLoader();
    expect(js).toContain('"/embed?"');
    expect(js).toContain("data-origin");
    expect(js).toContain("toposcope-fallback");
    expect(js).not.toContain("/share/v1");
  });
});
