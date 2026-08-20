import { describe, expect, test } from "bun:test";
import {
  inspectTabKey,
  inspectTabLabel,
  upsertInspectTab,
  type InspectTab,
} from "./inspect-tabs";

describe("upsertInspectTab", () => {
  test("shares the cap 5 strip between trace and profile", () => {
    const tabs: InspectTab[] = [1, 2, 3, 4].map((n) => ({
      kind: "trace",
      key: "trace_id",
      value: `t${n}`,
      ts: "2026-08-16T15:00:00.000Z",
      service: "nginx",
    }));
    tabs.push({
      kind: "profile",
      trace_id: "aa",
      span_id: "9f2c8b1a44d0e731",
      service: "wordpress",
      name: "do_action",
      ts: "2026-08-16T15:00:00.000Z",
    });
    const next = upsertInspectTab(tabs, {
      kind: "trace",
      key: "trace_id",
      value: "t5",
      ts: "2026-08-16T15:00:00.000Z",
      service: "nginx",
    });
    expect(next).toHaveLength(5);
    expect(next[0]).toMatchObject({ value: "t2" });
    expect(next[4]).toMatchObject({ value: "t5" });
  });
});

describe("inspectTabLabel", () => {
  test("profile and trace use the id prefix", () => {
    expect(
      inspectTabLabel({
        kind: "profile",
        trace_id: "aabbccddeeff00112233445566778899",
        span_id: "9f2c8b1a44d0e731",
        service: "wordpress",
        name: "do_action(save_post)",
        ts: "2026-08-16T15:00:00.000Z",
      }),
    ).toBe("profile 9f2c8b1a44d0");
    expect(
      inspectTabLabel({
        kind: "trace",
        key: "trace_id",
        value: "2620569ffffabc",
        ts: "2026-08-16T15:00:00.000Z",
        service: "nginx",
      }),
    ).toBe("trace 2620569ffffa");
    expect(
      inspectTabKey({
        kind: "trace",
        key: "trace_id",
        value: "2620569ffffabc",
        ts: "2026-08-16T15:00:00.000Z",
        service: "nginx",
      }),
    ).toBe("trace:2620569ffffabc");
  });
});
