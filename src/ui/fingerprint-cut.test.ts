import { describe, expect, test } from "bun:test";
import {
  fingerprintCutFetchKey,
  fingerprintCutHuntWindows,
  formatCutWindowLines,
} from "./fingerprint-cut";
import type { ChangeMark } from "../shared/change-mark";

const mark: ChangeMark = {
  id: "mk_cut",
  ts: "2026-08-14T14:11:00.000Z",
  end_ts: null,
  kind: "deploy",
  service: "worker",
  title: "v1.4.3",
  attrs: {},
};

describe("fingerprintCutFetchKey", () => {
  test("live ignores sliding from/to and refetches when span or q changes", () => {
    const live = {
      q: "level:error",
      live: true,
      spanMs: 3_600_000,
      from: "a",
      to: "b",
    };
    expect(fingerprintCutFetchKey(live)).toBe(
      fingerprintCutFetchKey({ ...live, from: "c", to: "d" }),
    );
    expect(fingerprintCutFetchKey(live)).not.toBe(
      fingerprintCutFetchKey({ ...live, spanMs: 7_200_000 }),
    );
    expect(fingerprintCutFetchKey(live)).not.toBe(
      fingerprintCutFetchKey({ ...live, q: "" }),
    );
  });

  test("idle hunts refetch when from/to change", () => {
    const idle = {
      q: "",
      live: false,
      spanMs: 3_600_000,
      from: "a",
      to: "b",
    };
    expect(fingerprintCutFetchKey(idle)).not.toBe(
      fingerprintCutFetchKey({ ...idle, from: "c" }),
    );
  });
});

describe("formatCutWindowLines", () => {
  test("labels equal windows and uses band when the incident is closed", () => {
    const openedAt = "2026-08-14T15:00:00.000Z";
    const huntFrom = Date.parse("2026-08-14T14:00:00.000Z");
    const huntTo = Date.parse(openedAt);
    const point = fingerprintCutHuntWindows(mark, openedAt, huntFrom, huntTo);
    const lines = formatCutWindowLines(point, huntTo);
    expect(lines[0]?.k).toBe("after");
    expect(lines[0]?.v).toContain("14:11:00");
    expect(lines[1]?.k).toBe("before");
    expect(lines[1]?.v).toContain("equal 49m");
    const incident: ChangeMark = {
      ...mark,
      kind: "incident",
      ts: "2026-08-14T03:10:00.000Z",
      end_ts: "2026-08-14T04:12:00.000Z",
    };
    const band = fingerprintCutHuntWindows(
      incident,
      openedAt,
      Date.parse("2026-08-14T00:00:00.000Z"),
      huntTo,
    );
    expect(formatCutWindowLines(band, huntTo)[0]?.k).toBe("band");
  });
});
