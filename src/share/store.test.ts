import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrateControlDb } from "../control/index";
import { defaultShareLimits as limits } from "./limits";
import { parseShareScope, type ShareScope } from "./scope";
import { listShares, parseShareExpiry, parseShareName, putShare, revokeShare, shareBySecret } from "./store";

const now = Date.parse("2026-10-23T12:00:00Z");
const day = 86_400_000;

function memDb(): Database {
  const db = new Database(":memory:");
  migrateControlDb(db);
  return db;
}

function scope(): ShareScope {
  const parsed = parseShareScope({ metric_names: ["fleet_*"], metric_labels: "service:agental" });
  if ("error" in parsed) {
    throw new Error(parsed.error);
  }
  return parsed;
}

describe("share store", () => {
  test("a secret opens its share until it expires or is revoked", () => {
    const db = memDb();
    const { share, secret, created } = putShare({ name: "console", scope: scope(), limits, expires_at: now + day }, now, db);
    expect(created).toBe(true);
    expect(secret).toStartWith("tss1_");
    expect(shareBySecret(secret!, now, db)?.name).toBe("console");
    expect(shareBySecret(secret!, now + day, db)).toBeNull();
    expect(shareBySecret("tss1_wrong", now, db)).toBeNull();
    revokeShare("console", now + 1, db);
    expect(shareBySecret(secret!, now + 2, db)).toBeNull();
    expect(listShares(db)[0]?.revoked_at).toBe(now + 1);
    expect(share.scope.metric_labels).toEqual({ service: "agental" });
  });

  test("a change keeps the secret; a revoked name starts over with a new one", () => {
    const db = memDb();
    const first = putShare({ name: "console", scope: scope(), limits, expires_at: now + day }, now, db);
    const changed = putShare({ name: "console", scope: scope(), limits, expires_at: now + 2 * day }, now, db);
    expect(changed.secret).toBeNull();
    expect(changed.share.expires_at).toBe(now + 2 * day);
    expect(shareBySecret(first.secret!, now, db)?.expires_at).toBe(now + 2 * day);
    revokeShare("console", now, db);
    const again = putShare({ name: "console", scope: scope(), limits, expires_at: now + day }, now, db);
    expect(again.created).toBe(true);
    expect(shareBySecret(first.secret!, now, db)).toBeNull();
    expect(shareBySecret(again.secret!, now, db)?.revoked_at).toBeNull();
  });

  test("names and expiry", () => {
    expect(parseShareName(" Agental-Console ")).toBe("agental-console");
    expect(parseShareName("a b")).toBeNull();
    expect(parseShareExpiry("2027-10-23", now)).toBe(Date.parse("2027-10-23T00:00:00Z"));
    expect(parseShareExpiry(now - 1, now)).toEqual({ error: "expires_at must be in the future" });
    expect(parseShareExpiry(now + 366 * day, now)).toEqual({ error: "expires_at is at most 365 days out" });
    expect(parseShareExpiry(undefined, now)).toHaveProperty("error");
  });
});
