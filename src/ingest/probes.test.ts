import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ingestProbesRoute } from "./probes";
import { MAX_BODY_BYTES } from "./index";

describe("ingestProbesRoute", () => {
  const app = new Hono();
  app.post("/v1/probes", ingestProbesRoute);

  test("rejects empty, bad json, missing up, and oversize bodies", async () => {
    const empty = await app.request("/v1/probes", {
      method: "POST",
      body: "   ",
    });
    expect(empty.status).toBe(400);

    const bad = await app.request("/v1/probes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(bad.status).toBe(400);

    const missing = await app.request("/v1/probes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ service: "billing" }),
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      error: "up must be 0 or 1, or url to pull",
    });

    const arrayPull = await app.request("/v1/probes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        { service: "billing", url: "https://billing.example/health" },
      ]),
    });
    expect(arrayPull.status).toBe(400);

    const huge = await app.request("/v1/probes", {
      method: "POST",
      body: "x".repeat(MAX_BODY_BYTES + 1),
    });
    expect(huge.status).toBe(413);
  });
});
