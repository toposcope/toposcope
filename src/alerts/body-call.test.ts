import { afterAll, describe, expect, test } from "bun:test";
import { firstSeenFillValues, renderWebhook, alertWebhookBody, thresholdFillValues } from "./payload";
import { sendTestCall } from "./test-call";

// Stand-ins for the services #108 names: Pushover checks its fields, ntfy keeps the text.
const seen: Array<{ path: string; type: string; body: string }> = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const body = await req.text();
    seen.push({ path, type: req.headers.get("content-type") ?? "", body });
    if (path === "/1/messages.json") {
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(body);
      } catch {
        return Response.json({ status: 0, errors: ["body is not JSON"] }, { status: 400 });
      }
      const missing = ["token", "user", "message"].filter((k) => typeof json[k] !== "string" || !json[k]);
      if (missing.length > 0) {
        return Response.json({ [missing[0]!]: "invalid", errors: [`${missing[0]} is missing`], status: 0, request: "r-1" }, { status: 400, statusText: "Bad Request" });
      }
      return Response.json({ status: 1, request: "r-1" });
    }
    return new Response("ok");
  },
});
afterAll(() => server.stop());
const at = (path: string) => `http://127.0.0.1:${server.port}${path}`;

const values = thresholdFillValues({
  name: "api p99 slow",
  agg: "p99:duration_ms",
  value: 912.345,
  threshold: 800,
  query: 'service:api message:"a \\"b\\" c"',
  firedAt: "2026-10-16T12:04:51.000Z",
  link: null,
});

describe("a body of its own reaches the service (#108)", () => {
  test("a Pushover JSON body with token, user and message is accepted", async () => {
    const payload = renderWebhook(
      {
        body_kind: "json",
        body_template: '{"token": "app-token", "user": "user-key", "message": "{{alert.name}}: {{series}} {{value}} ≥ {{threshold}} for {{query}}"}',
      },
      {},
      values,
    );
    const result = await sendTestCall(at("/1/messages.json"), payload);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.reply).toBe('{"status":1,"request":"r-1"}');
    const sent = seen.at(-1)!;
    expect(sent.type).toBe("application/json");
    expect(JSON.parse(sent.body).message).toBe('api p99 slow: p99(duration_ms) 912.345 ≥ 800 for service:api message:"a \\"b\\" c"');
  });

  test("a text body reaches an ntfy topic as that text", async () => {
    const payload = renderWebhook(
      { body_kind: "text", body_template: "{{alert.name}}: {{fingerprints.count}} new after {{mark.kind}} {{mark.version}}\n{{fingerprints}}\n{{more}}\n{{link}}" },
      {},
      firstSeenFillValues({
        name: "new bugs after a deploy",
        query: "level:error service:api",
        mark: { id: "mk", kind: "deploy", service: "api", title: "v0.9.3", ts: "2026-10-16T10:42:07.311Z" },
        fingerprints: [
          { e1: "9b1e4c07a3f2d851", type: "TypeError", message: 'TypeError: Cannot read properties of undefined (reading "plan")', first_seen: null, events: 14 },
          { e1: "41aa0c9e7d2b6f13", type: "", message: "zfs clone failed: dataset tank/base@2026-10-16 does not exist", first_seen: null, events: 3 },
        ],
        more: 0,
        link: "https://toposcope.example.com/?cut=mk",
      }),
    );
    const result = await sendTestCall(at("/agental-ops"), payload);
    expect(result.ok).toBe(true);
    const sent = seen.at(-1)!;
    expect(sent.type).toBe("text/plain; charset=utf-8");
    expect(sent.body).toBe(
      'new bugs after a deploy: 2 new after deploy v0.9.3\nTypeError: Cannot read properties of undefined (reading "plan") · e1:9b1e4c07a3f2d851 · 14 events\nzfs clone failed: dataset tank/base@2026-10-16 does not exist · e1:41aa0c9e7d2b6f13 · 3 events\n\nhttps://toposcope.example.com/?cut=mk',
    );
  });

  test("a 400 says so, with the reply and the body as it was sent", async () => {
    const payload = renderWebhook({ body_kind: "json", body_template: '{"token": "app-token", "message": "{{alert.name}}"}' }, {}, values);
    const result = await sendTestCall(at("/1/messages.json"), payload);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.reply).toContain('"errors":["user is missing"]');
    expect(result.sent).toBe('{"token": "app-token", "message": "api p99 slow"}');
  });

  test("an alert without a body sends today's bytes", () => {
    const today = alertWebhookBody({
      url: "https://example.com/hook",
      alert: { id: "a", name: "api p99 slow", threshold: 800 },
      count: 64,
      value: 912,
      agg: "p99:duration_ms",
      query: "service:api",
      firedAt: "2026-10-16T12:04:51.000Z",
    });
    expect(renderWebhook({ body_kind: "default", body_template: "{{alert.name}}" }, today, values)).toEqual({
      body: JSON.stringify(today),
      contentType: "application/json",
    });
  });

  test("nothing listening: no status, and why", async () => {
    const result = await sendTestCall("http://127.0.0.1:9/nothing", { body: "x", contentType: "text/plain; charset=utf-8" });
    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.status_text.length).toBeGreaterThan(0);
  });
});
