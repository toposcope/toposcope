import { describe, expect, test } from "bun:test";
import { hideWebhooks, KeptRefused, keptWebhooks, redactedUrl } from "./webhooks";

// A webhook's URL is its credential (#361): MCP shows its host and a handle, and takes the handle back.
const slack = "https://hooks.slack.com/services/T000/B000/XXXXSECRET";
const discord = "https://discord.com/api/webhooks/1/SECRET2";

describe("webhooks through MCP (#361)", () => {
  test("a monitor's webhooks are shown as their host and a handle, default as it is", () => {
    const shown = hideWebhooks({ monitors: [{ webhook_url: slack, webhook_urls: ["default", slack, discord] }] }, "p1", [slack, discord]) as any;
    const m = shown.monitors[0];
    expect(m.webhook_url).toMatch(/^https:\/\/hooks\.slack\.com\/… kept:[0-9a-f]{12}$/);
    expect(m.webhook_urls[0]).toBe("default");
    expect(m.webhook_urls[1]).toBe(m.webhook_url);
    expect(m.webhook_urls[2]).toMatch(/^https:\/\/discord\.com\/… kept:[0-9a-f]{12}$/);
    expect(JSON.stringify(shown)).not.toContain("SECRET");
  });

  test("a stored webhook anywhere else in an answer is hidden too, longest first", () => {
    const shown = hideWebhooks({ calls: [{ error: `POST ${slack} answered 500` }], note: `${slack}/extra` }, "p1", [slack, `${slack}/extra`]) as any;
    expect(shown.calls[0].error).toBe("POST https://hooks.slack.com/… answered 500");
    expect(shown.note).toBe("https://hooks.slack.com/…");
    expect(redactedUrl("not a url")).toBe("…");
  });

  test("a handle given back by the caller it was shown to is the URL again; anyone else's is refused", () => {
    const shown = (hideWebhooks({ webhook_urls: [slack] }, "p1", []) as any).webhook_urls[0] as string;
    expect(keptWebhooks({ name: "x", body: { webhook_urls: ["default", shown], webhook_url: shown } }, "p1")).toEqual({
      name: "x",
      body: { webhook_urls: ["default", slack], webhook_url: slack },
    });
    expect(() => keptWebhooks({ body: { webhook_urls: [shown] } }, "p2")).toThrow(KeptRefused);
    expect(() => keptWebhooks({ body: { webhook_url: "https://x/… kept:000000000000" } }, "p1")).toThrow(KeptRefused);
    // A handle outside a webhook field is just text.
    expect(keptWebhooks({ q: shown }, "p1")).toEqual({ q: shown });
  });

  test("the same URL keeps its handle, so a preview and its save match", () => {
    const a = (hideWebhooks({ webhook_url: discord }, "p1", []) as any).webhook_url;
    const b = (hideWebhooks({ webhook_url: discord }, "p1", []) as any).webhook_url;
    expect(a).toBe(b);
  });
});
