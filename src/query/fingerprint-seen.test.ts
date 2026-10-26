import { beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { fingerprintHexRe, fingerprintSeenRoute } from "./fingerprint-seen";
import { clickhouseCommand } from "../shared/clickhouse";

process.env.CLICKHOUSE_URL ??= "http://127.0.0.1:8123";
process.env.CLICKHOUSE_USER ??= "default";
process.env.CLICKHOUSE_PASSWORD ??= "toposcope";

const app = new Hono();
app.get("/api/fingerprints/:hex", fingerprintSeenRoute);
const hex = `f${Date.now().toString(16)}e1`;
const now = Date.now();

describe("GET /api/fingerprints/:hex (#261)", () => {
  test("refuses what is not a fingerprint", async () => {
    expect(fingerprintHexRe.test("a91f2c")).toBe(true);
    expect(fingerprintHexRe.test("not-hex")).toBe(false);
    expect((await app.request("/api/fingerprints/zz")).status).toBe(400);
    expect((await app.request("/api/fingerprints/a91f2c?from=2026-10-26T13:00:00Z&to=2026-10-26T12:00:00Z")).status).toBe(400);
  });

  describe("with rows", () => {
    beforeAll(async () => {
      const ts = (ago: number) => new Date(now - ago).toISOString().slice(0, 23).replace("T", " ");
      const row = (ago: number, host: string) => `('${ts(ago)}', 'billing', '${host}', 'error', 'charge failed', map('e1', '${hex}'))`;
      await clickhouseCommand(
        `INSERT INTO logs (ts, service, host, level, message, attr_map) VALUES ${[row(50 * 60_000, "billing-1"), row(20 * 60_000, "billing-2"), row(5 * 60_000, "billing-2")].join(", ")}`,
      );
    });
    test("first and last seen, count and hosts", async () => {
      const res = await app.request(`/api/fingerprints/${hex}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { first_ts: string; last_ts: string; count: number; hosts: number };
      expect(body.count).toBe(3);
      expect(body.hosts).toBe(2);
      expect(Math.abs(Date.parse(body.first_ts) - (now - 50 * 60_000))).toBeLessThan(2000);
      expect(Date.parse(body.last_ts)).toBeGreaterThan(Date.parse(body.first_ts));
    });
    test("an id with no rows answers zero, not a 404", async () => {
      const body = (await (await app.request("/api/fingerprints/abcdef0123")).json()) as { count: number; first_ts: null };
      expect(body.count).toBe(0);
      expect(body.first_ts).toBeNull();
    });
  });
});
