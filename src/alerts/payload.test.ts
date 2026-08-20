import { describe, expect, test } from "bun:test";
import { alertWebhookBody, isSlackIncomingUrl, parseSilenceFor } from "./payload";

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

describe("parseSilenceFor", () => {
  test("allow-lists 1h 4h 24h", () => {
    expect(parseSilenceFor("1h")).toBe("1h");
    expect(parseSilenceFor("nope")).toBeUndefined();
  });
});
