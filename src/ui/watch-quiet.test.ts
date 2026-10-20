import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { monitorSentence } from "./alert-condition";
import { MonitorRail } from "./components/monitor-rail";
import type { MonitorStretch, MonitorView } from "./types";
import { cantTellNow, lastLineWords, laneKind, laneReadout, openCardLine, opensWhenLine } from "./watch";

const minute = 60_000;
const now = Date.parse("2026-10-20T11:03:00.000Z");
const lastLine = Date.parse("2026-10-20T10:26:41.000Z");

const stretch = (over: Partial<MonitorStretch> = {}): MonitorStretch => ({
  id: "st-1",
  monitor_id: "m-quiet",
  opened_at: now - 22 * minute,
  resolved_at: null,
  closed_by: null,
  open_value: 0,
  open_message: "no line for 15m",
  last_value: 0,
  last_at: now,
  called_at: now - 22 * minute,
  open_call: "sent",
  resolved_call: null,
  calls: [],
  ...over,
});

/** 18c's ci-box went quiet: search · fewer than 1 · 15m. */
const quiet = (over: Partial<MonitorView> = {}): MonitorView => ({
  id: "m-quiet",
  name: "ci-box went quiet",
  kind: "threshold",
  source: "search",
  state: "ok",
  enabled: 1,
  remind_every: "4h",
  resolved_body: null,
  last_mark: null,
  body_kind: "default",
  body_template: null,
  saved_search_id: "s2",
  threshold: 1,
  webhook_url: "https://ntfy.sh/agental-ops",
  last_fired_at: null,
  last_attempt_at: null,
  last_status: null,
  last_error: null,
  consecutive_failures: 0,
  silenced_until: null,
  last_result: "ok",
  last_value: 4,
  last_result_at: now - minute,
  opens_when: "fewer_than",
  cant_tell: null,
  saved: { id: "s2", name: "ci-box lines", query: "host:ci-box", range: "15m", agg: null },
  open: null,
  last_line_at: lastLine,
  ...over,
});

describe("Watch reads a quiet search (#176, 18c)", () => {
  test("its lane and its open card say fewer than, and when the last line came", () => {
    expect(laneKind(quiet())).toBe("search · fewer than 1 · 15m");
    const open = quiet({ state: "open", open: stretch() });
    expect(openCardLine(open, now)).toBe("search · host:ci-box · fewer than 1 line in 15m · last line 10:26");
    expect(opensWhenLine(quiet({ threshold: 5 }))).toBe("fewer than 5 lines in 15m");
    expect(opensWhenLine(quiet({ threshold: 0.5, saved: { id: "s3", name: "api rate", query: "service:api", range: "15m", agg: "rate" } }))).toBe(
      "rate fewer than 0.5 in 15m",
    );
    // At least reads as it did.
    expect(laneKind(quiet({ opens_when: "at_least", threshold: 50 }))).toBe("search · at least 50 · 15m");
  });

  test("last line: when, and how long ago; none in a year; not read yet", () => {
    expect(lastLineWords(lastLine, now)).toBe("10:26:41, 36m ago");
    expect(lastLineWords(lastLine - 24 * 60 * minute, now)).toBe("10-19 10:26:41, 24h 36m ago");
    expect(lastLineWords(null, now)).toBe("none in a year");
    expect(lastLineWords(undefined, now)).toBe("—");
  });

  test("while it can't tell it stays ok, and the lane says so with the reason on hover", () => {
    const starting = quiet({ cant_tell: { kind: "starting", at: now, until: now + 11 * minute } });
    expect(cantTellNow(starting, now)).toBe("starting, up 4m of 15m");
    expect(laneReadout(starting, now, 0)).toEqual({
      badge: "ok",
      tone: "sec",
      text: "can't tell",
      title: "can't tell: starting, up 4m of 15m",
    });
    const held = quiet({ cant_tell: { kind: "held", at: now, sources: [{ name: "prod-us", state: "behind" }] } });
    expect(laneReadout(held, now, 0).title).toBe("can't tell: prod-us behind");
    expect(laneReadout(quiet({ last_status: "refused" }), now, 0).title).toBe("can't tell: a refused reading");
    // A loud search that was refused says refused, as before.
    expect(laneReadout(quiet({ opens_when: "at_least", last_status: "refused" }), now, 0).text).toBe("refused");
    // Open, it says how long.
    expect(laneReadout(quiet({ state: "open", open: stretch(), cant_tell: held.cant_tell }), now, 0).badge).toBe("open 22m");
  });

  test("the monitor beside its hunt says what opens it, the last line, and why it can't tell", () => {
    const text = renderToStaticMarkup(
      createElement(MonitorRail, {
        monitor: quiet({ cant_tell: { kind: "held", at: now, sources: [{ name: "prod-us", state: "quiet" }] } }),
        nowMs: now,
        onClose: () => {},
        onEdit: () => {},
        onPause: () => {},
        onSilence: () => {},
      }),
    )
      .replace(/<[^>]+>/g, " ")
      .replace(/&#x27;/g, "'")
      .replace(/\s+/g, " ");
    expect(text).toContain("opens when fewer than 1 in 15m");
    expect(text).toContain("last line 10:26:41, 36m ago");
    expect(text).toContain("can't tell prod-us quiet");
  });

  test("the editor's sentence for screen readers says fewer than", () => {
    expect(monitorSentence({ name: "ci-box lines", agg: null, range: "15m" }, "1", "4h", "fewer_than")).toBe(
      "Opens when ci-box lines’s count over its 15m is fewer than 1, reminds every 4h while open, and says when it resolved.",
    );
  });
});
