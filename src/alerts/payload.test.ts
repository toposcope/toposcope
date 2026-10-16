import { describe, expect, test } from "bun:test";
import { alertLink, alertWebhookBody, isSlackIncomingUrl, parseSilenceFor } from "./payload";

describe("isSlackIncomingUrl", () => {
  test("detects Slack incoming webhooks", () => {
    expect(
      isSlackIncomingUrl("https://hooks.slack.com/services/T/B/xxx"),
    ).toBe(true);
    expect(isSlackIncomingUrl("https://example.com/hook")).toBe(false);
  });
});

describe("alertWebhookBody", () => {
  const args = {
    alert: { id: "1", name: "errors", threshold: 10 },
    count: 12,
    value: 12,
    agg: null as string | null,
    query: "level:error",
    firedAt: "2026-08-15T00:00:00.000Z",
  };

  test("keeps the generic JSON payload and grows agg + value", () => {
    expect(alertWebhookBody({ ...args, url: "https://example.com/hook" })).toEqual({
      alert: args.alert,
      count: 12,
      value: 12,
      agg: null,
      query: "level:error",
      fired_at: args.firedAt,
    });
  });

  test("names a p99 series in Slack text", () => {
    const body = alertWebhookBody({
      ...args,
      value: 912,
      agg: "p99:duration_ms",
      alert: { id: "1", name: "slow", threshold: 800 },
      url: "https://hooks.slack.com/services/T/B/xxx",
    }) as { text: string };
    expect(body.text).toContain("Toposcope:");
    expect(body.text).toContain("slow");
    expect(body.text).toContain("p99(duration_ms) 912 ≥ 800");
  });
});

// #108: neither body linked back to Toposcope, which did not know its own address.
describe("the link back to Toposcope", () => {
  const window = {
    savedId: "s7",
    query: 'level:error service:"billing api"',
    agg: "p99:duration_ms",
    from: "2026-10-16T09:00:00.000Z",
    to: "2026-10-16T10:00:00.000Z",
  };
  const args = {
    alert: { id: "1", name: "slow", threshold: 800 },
    count: 12,
    value: 912,
    agg: "p99:duration_ms",
    query: window.query,
    firedAt: window.to,
  };
  const link = alertLink("https://logs.example.com", window);

  test("opens the saved search over the window that fired", () => {
    const url = new URL(link);
    expect(url.origin + url.pathname).toBe("https://logs.example.com/");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: window.query,
      range: "custom",
      from: window.from,
      to: window.to,
      agg: "p99:duration_ms",
      saved: "s7",
    });
  });

  test("keeps a proxy's path, and leaves agg out for a count", () => {
    const url = new URL(alertLink("https://example.com/toposcope", { ...window, agg: null }));
    expect(url.pathname).toBe("/toposcope/");
    expect(url.searchParams.has("agg")).toBe(false);
  });

  test("the JSON body gains link when there is one", () => {
    expect(alertWebhookBody({ ...args, url: "https://example.com/hook", link })).toEqual({
      alert: args.alert,
      count: 12,
      value: 912,
      agg: "p99:duration_ms",
      query: window.query,
      fired_at: args.firedAt,
      link,
    });
  });

  test("a Slack message links to it", () => {
    const body = alertWebhookBody({ ...args, url: "https://hooks.slack.com/services/T/B/xxx", link }) as {
      blocks: Array<{ text: { text: string } }>;
    };
    expect(body.blocks[0]!.text.text).toContain(`<${link}|Open in Toposcope>`);
  });

  test("without an address both bodies are as they were", () => {
    expect(alertWebhookBody({ ...args, url: "https://example.com/hook", link: null })).not.toHaveProperty("link");
    const slack = alertWebhookBody({ ...args, url: "https://hooks.slack.com/services/T/B/xxx", link: null }) as {
      blocks: Array<{ text: { text: string } }>;
    };
    expect(slack.blocks[0]!.text.text).not.toContain("Open in Toposcope");
  });
});

describe("parseSilenceFor", () => {
  test("allow-lists 1h 4h 24h", () => {
    expect(parseSilenceFor("1h")).toBe("1h");
    expect(parseSilenceFor("nope")).toBeUndefined();
  });
});
