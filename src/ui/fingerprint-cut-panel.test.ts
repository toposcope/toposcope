import { describe, expect, setSystemTime, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FingerprintCutPanel } from "./components/fingerprint-cut-panel";
import type { ChangeMark } from "../shared/change-mark";
import type { FingerprintCutResult } from "../shared/fingerprint-cut";
import { toLocalInput } from "./search-url";

// Frames 15a and 15c of the Fingerprints Alert sheet: a deploy 18 minutes old,
// with two later deploys inside its after side.
const mark: ChangeMark = {
  id: "mk_v091",
  kind: "deploy",
  service: "api",
  title: "v0.9.1",
  ts: "2026-10-16T10:42:07.311Z",
  end_ts: null,
  attrs: {},
};
const openedAt = "2026-10-16T11:00:12.000Z";
const minute = 60_000;
const hour = 60 * minute;
const side = Date.parse(openedAt) - Date.parse(mark.ts);

const result: FingerprintCutResult = {
  title: "deployed: api v0.9.1",
  windows: {
    afterFrom: mark.ts,
    afterTo: openedAt,
    beforeFrom: new Date(Date.parse(mark.ts) - hour).toISOString(),
    beforeTo: mark.ts,
    sideMs: side,
    beforeMs: hour,
    waiting: true,
    banded: false,
    dead: false,
    inside: [
      { id: "mk_v092", kind: "deploy", ts: "2026-10-16T10:50:13.000Z", label: "deployed: api v0.9.2", title: "v0.9.2", side: "after" },
    ],
    insideMore: 0,
  },
  notes: ["One more deploy is inside the after side. A first seen row's time says which one it follows."],
  sets: [
    {
      id: "first_seen",
      name: "First seen",
      def: "after the cut, not in the hour before",
      count: 1,
      more: 0,
      rows: [{ hex: "9b1e4c07a3f2d851", message: "TypeError: Cannot read properties of undefined", service: "api", level: "error", before: 0, after: 14, extra: "first 10:52:51", follows: "after v0.9.2" }],
    },
    { id: "still_here", name: "Still here", def: "both sides of the cut", count: 0, more: 0, rows: [] },
    { id: "stopped", name: "Stopped", def: "before the cut, quiet after", count: 0, more: 0, rows: [], waiting: { haveMs: side, needMs: hour } },
  ],
  empty: "",
};

function render(): string {
  const from = toLocalInput(new Date(Date.parse(openedAt) - 4 * hour));
  const to = toLocalInput(new Date(openedAt));
  return renderToStaticMarkup(
    createElement(FingerprintCutPanel, {
      mark, openedAt, q: "level:error", range: "custom", from, to, live: false,
      spanMs: 4 * hour, fromMs: Date.parse(openedAt) - 4 * hour, toMs: Date.parse(openedAt),
      result, onResult: () => {}, onClose: () => {}, onFilter: () => {},
    }),
  );
}

describe("the Fingerprints panel near a deploy (#111)", () => {
  // Stamps drop the date on the day they are read, so the panel is read on the frames' day.
  setSystemTime(new Date(openedAt));
  const html = render();
  setSystemTime();
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  test("window lines: the cut, the after side's length, the before side's minimum", () => {
    expect(text).toContain("cut at 10-16 10:42:07.311");
    expect(text).toContain("after 10:42:07 → 11:00:12 · 18m 5s");
    expect(text).toContain("before 09:42:07 → 10:42:07 · 1h, at least");
  });

  test("Stopped waits, says how long it has, and has no count", () => {
    expect(text).toContain("Not called yet: 18m 5s of 1h after the cut.");
    expect(html).toContain('role="progressbar"');
    expect(text).toContain("An error quiet for 18 minutes has not stopped. Stopped is called when the after side has the hour the before side has.");
    expect(text).not.toContain("Stopped 0");
  });

  test("a row's counts say each side's length, and which later deploy it follows", () => {
    expect(html).toContain('title="events 1h before → 18m 5s after"');
    expect(text).toContain("first 10:52:51 after v0.9.2");
  });

  test("the later deploy is named inside the after side", () => {
    expect(text).toContain("inside");
    expect(text).toContain("deployed api v0.9.2 · 10:50:13");
    expect(text).toContain("One more deploy is inside the after side.");
  });
});
