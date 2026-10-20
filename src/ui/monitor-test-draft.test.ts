import { describe, expect, test } from "bun:test";
import { monitorTestDraft } from "./alert-condition";

const base = {
  name: "ci-box went quiet",
  kind: "threshold" as const,
  savedSearchId: "s2",
  threshold: 1,
  thresholdOk: true,
  opensWhen: "fewer_than" as const,
  webhook: "https://ntfy.sh/agental-ops",
  bodyKind: "json" as const,
  bodyTemplate: '{ "title": "{{alert.name}} {{state}}" }',
  resolvedBody: '{ "title": "{{alert.name}} resolved" }',
  problem: false,
};

describe("Send a test call sends the draft as it stands (#175, #176)", () => {
  test("with a resolved body, the test sends it too, as 18t says", () => {
    expect(monitorTestDraft(base)).toMatchObject({ resolved_body: '{ "title": "{{alert.name}} resolved" }' });
  });

  test("a default body, or an empty resolved body, sends none", () => {
    expect(monitorTestDraft({ ...base, bodyKind: "default" })).not.toHaveProperty("resolved_body");
    expect(monitorTestDraft({ ...base, resolvedBody: "  " })).not.toHaveProperty("resolved_body");
  });

  test("it reads fewer than as the monitor will; a fingerprints draft reads at least", () => {
    expect(monitorTestDraft(base)).toMatchObject({ opens_when: "fewer_than", threshold: 1 });
    expect(monitorTestDraft({ ...base, kind: "first_seen" })).toMatchObject({ opens_when: "at_least" });
  });

  test("nothing to send without a webhook, or while the server would refuse it", () => {
    expect(monitorTestDraft({ ...base, webhook: "ntfy.sh/x" })).toBeNull();
    expect(monitorTestDraft({ ...base, problem: true })).toBeNull();
  });
});
