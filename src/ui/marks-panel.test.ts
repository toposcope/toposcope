import { describe, expect, test } from "bun:test";
import type { ChangeMark } from "../shared/change-mark";
import { attrLine, inWindow, markFrom, panelRows, utcDayStart } from "./marks-panel";

const m = (id: string, kind: ChangeMark["kind"], ts: string, attrs: Record<string, string> = {}, service = ""): ChangeMark => ({ id, ts, end_ts: null, kind, service, title: id, attrs });

describe("the marks panel (#262, 26f)", () => {
  test("today in UTC, a day at a time further back", () => {
    const now = Date.parse("2026-10-26T13:26:00Z");
    expect(new Date(utcDayStart(now)).toISOString()).toBe("2026-10-26T00:00:00.000Z");
    expect(new Date(utcDayStart(now, 1)).toISOString()).toBe("2026-10-25T00:00:00.000Z");
  });
  test("rows are newest first, without the kinds turned off", () => {
    const rows = panelRows([m("a", "deploy", "2026-10-26T09:12:00Z"), m("b", "incident", "2026-10-26T13:02:00Z"), m("c", "note", "2026-10-26T08:40:00Z")], ["note"]);
    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
  });
  test("where a mark came from, and its attrs in one line", () => {
    const v09 = m("v0.9", "deploy", "2026-10-26T12:48:00Z", { source: "ci", sha: "4f9c1e22", version: "v0.9", by: "github-actions" }, "billing");
    expect(markFrom(v09)).toBe("ci · sha 4f9c1e");
    expect(markFrom(m("n", "note", "2026-10-26T08:40:00Z"))).toBe("here");
    expect(attrLine(v09)).toBe("version=v0.9 · service=billing · by github-actions");
  });
  test("how many sit in the hunt's window", () => {
    const marks = [m("a", "deploy", "2026-10-26T12:48:00Z"), m("b", "deploy", "2026-10-26T09:12:00Z")];
    expect(inWindow(marks, Date.parse("2026-10-26T12:26:00Z"), Date.parse("2026-10-26T13:26:00Z"))).toBe(1);
  });
});
