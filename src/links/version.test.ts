import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { migrateControlDb } from "../control/index";
import { decodeLinkKey, encodeLinkKey, linkKeyOlder } from "./key";
import { here, linkProtocol, mismatchWords, olderRelease, refuseOtherVersion, versionHeaders, versionRefusal } from "./version";

const key = { kind: "offer" as const, name: "edge-1", url: "https://edge-1.example.com", kid: "k7f3a", q: "", until: null, secret: "s".repeat(43), kinds: ["logs" as const] };

describe("a link names its protocol; different versions refuse (#328)", () => {
  test("keys start tsl2_, and a tsl1_ key is refused at paste with one line", () => {
    const text = encodeLinkKey(key);
    expect(text.startsWith("tsl2_o.")).toBe(true);
    expect(decodeLinkKey(text)).toMatchObject({ kind: "offer", name: "edge-1" });
    expect(decodeLinkKey(text.replace("tsl2_o", "tsl1_o"))).toEqual({ error: linkKeyOlder });
    expect(linkKeyOlder).toBe("This key is from an older Toposcope; mint a new one there");
  });

  test("the words say which side to upgrade", () => {
    const mine = { ...here(), version: "0.12.0" };
    expect(mismatchWords("edge-1", { ...mine, schema: 0, version: "0.11.0" }, mine)).toBe(
      "edge-1 is on 0.11.0, this instance on 0.12.0: upgrade edge-1.",
    );
    expect(mismatchWords("edge-1", { ...mine, schema: 9, version: "0.13.1" }, mine)).toBe(
      "edge-1 is on 0.13.1, this instance on 0.12.0: upgrade this instance.",
    );
    expect(olderRelease("0.9.0", "0.10.0")).toBe(true);
    expect(olderRelease("0.10.0", "0.9.0")).toBe(false);
    expect(olderRelease("an older release", "0.10.0")).toBe(true);
  });

  test("a route answers 409 with its versions to a caller that sends none or others, and serves the same", async () => {
    const app = new Hono();
    app.post("/link/v1/feed", (c) => refuseOtherVersion(c) ?? c.json({ ok: true }));
    const none = await app.request("/link/v1/feed", { method: "POST" });
    expect(none.status).toBe(409);
    expect(await versionRefusal(none)).toEqual(here());
    const other = await app.request("/link/v1/feed", { method: "POST", headers: { ...versionHeaders(), "x-toposcope-schema": "999" } });
    expect(other.status).toBe(409);
    const same = await app.request("/link/v1/feed", { method: "POST", headers: versionHeaders() });
    expect(same.status).toBe(200);
    expect(await versionRefusal(same)).toBeNull();
  });

  test("links made before this protocol stop at upgrade; their record stays", () => {
    const db = new Database(":memory:");
    migrateControlDb(db);
    db.query(
      `INSERT INTO links (id, role, connects, peer_id, peer_name, peer_url, q, kid, secret, secret_hash, created_at, protocol)
       VALUES ('old', 'pull', 'we', 'p', 'edge-1', 'https://edge-1', '', 'k0001', 's', NULL, 1, 1),
              ('new', 'pull', 'we', 'p', 'edge-2', 'https://edge-2', '', 'k0002', 's', NULL, 1, ${linkProtocol})`,
    ).run();
    migrateControlDb(db);
    const rows = db.query("SELECT id, removed_at FROM links ORDER BY id").all() as Array<{ id: string; removed_at: number | null }>;
    expect(rows.find((r) => r.id === "old")?.removed_at).not.toBeNull();
    expect(rows.find((r) => r.id === "new")?.removed_at).toBeNull();
  });
});
