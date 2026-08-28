import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  bootAllowsRequest,
  healthFromPings,
  type BootPhase,
} from "./boot";

describe("healthFromPings", () => {
  test("200 only when ready and both stores ping", () => {
    expect(
      healthFromPings("schema", { clickhouse: true, sqlite: true }).status,
    ).toBe(503);
    expect(
      healthFromPings("schema", { clickhouse: true, sqlite: true }).body,
    ).toEqual({
      ok: false,
      phase: "schema",
      clickhouse: true,
      sqlite: true,
    });
    expect(
      healthFromPings("ready", { clickhouse: true, sqlite: false }).status,
    ).toBe(503);
    expect(
      healthFromPings("ready", { clickhouse: true, sqlite: true }),
    ).toEqual({
      status: 200,
      body: {
        ok: true,
        phase: "ready",
        clickhouse: true,
        sqlite: true,
      },
    });
  });
});

describe("bootAllowsRequest", () => {
  const closed: BootPhase[] = ["starting", "schema", "repair"];
  test("health and metrics stay open while migrate runs", () => {
    for (const phase of closed) {
      expect(bootAllowsRequest(phase, "/api/health")).toBe(true);
      expect(bootAllowsRequest(phase, "/api/metrics")).toBe(true);
      expect(bootAllowsRequest(phase, "/api/search")).toBe(false);
      expect(bootAllowsRequest(phase, "/v1/logs")).toBe(false);
      expect(bootAllowsRequest(phase, "/v1/marks")).toBe(false);
    }
    expect(bootAllowsRequest("ready", "/api/search")).toBe(true);
  });
});

describe("boot gate", () => {
  test("search is 503 with phase until ready", async () => {
    let phase: BootPhase = "schema";
    const app = new Hono();
    app.get("/api/health", (c) => {
      const health = healthFromPings(phase, { clickhouse: true, sqlite: true });
      return c.json(health.body, health.status);
    });
    app.use("/*", async (c, next) => {
      if (bootAllowsRequest(phase, c.req.path)) {
        return next();
      }
      return c.json({ error: "not ready", phase }, 503);
    });
    app.get("/api/search", (c) => c.json({ ok: true }));

    const closed = await app.request("/api/search");
    expect(closed.status).toBe(503);
    expect(await closed.json()).toEqual({ error: "not ready", phase: "schema" });
    const health = await app.request("/api/health");
    expect(health.status).toBe(503);
    expect(((await health.json()) as { phase: string }).phase).toBe("schema");

    phase = "ready";
    const open = await app.request("/api/search");
    expect(open.status).toBe(200);
    const ready = await app.request("/api/health");
    expect(ready.status).toBe(200);
  });
});

describe("app boot order", () => {
  test("listens before migrateStore", async () => {
    const src = await Bun.file(`${import.meta.dir}/../index.ts`).text();
    const exported = src.indexOf("export default");
    const migrate = src.indexOf("await migrateStore()");
    expect(exported).toBeGreaterThan(-1);
    expect(migrate).toBeGreaterThan(exported);
  });
});
