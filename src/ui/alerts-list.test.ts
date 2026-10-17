import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AlertsView, type AlertSeriesView } from "./components/alerts-view";
import type { AlertRule, SavedSearch } from "./types";

const base: AlertRule = {
  id: "r",
  name: "api errors",
  kind: "threshold",
  last_mark: null,
  body_kind: "default",
  body_template: null,
  saved_search_id: "s1",
  threshold: 2000,
  webhook_url: "https://hooks.slack.com/services/T0/B0/x",
  last_fired_at: null,
  last_attempt_at: null,
  last_status: null,
  last_error: null,
  consecutive_failures: 0,
  silenced_until: null,
};

const saved = [{ id: "s1", name: "api errors", query: "level:error service:api", agg: null }] as unknown as SavedSearch[];

function html(alerts: AlertRule[], series: Record<string, AlertSeriesView> = {}): string {
  return renderToStaticMarkup(
    createElement(AlertsView, {
      alerts,
      saved,
      series,
      onOpenSearch: () => {},
      onEdit: () => {},
      onCreate: () => {},
      onSilence: () => {},
    }),
  );
}

function text(alerts: AlertRule[]): string {
  return html(alerts)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

// A rule that has never fired or been attempted has `last_status` null, and the
// list read null as "error": every new alert showed a red "failed error" under
// its webhook before anything had failed.
describe("the Alerts list's webhook column", () => {
  test("a rule never attempted says no failure; one that failed still does", () => {
    expect(text([base])).not.toContain("failed");
    expect(text([{ ...base, last_status: "200", last_fired_at: Date.parse("2026-10-17T09:15:00Z") }])).not.toContain(
      "failed",
    );
    expect(text([{ ...base, last_status: "error", last_error: "eval failed" }])).toContain("failed error");
    expect(text([{ ...base, last_status: "500", consecutive_failures: 2 }])).toContain("failed 500 ×2");
    expect(text([{ ...base, last_status: "refused" }])).toContain("refused");
  });
});

/** The threshold row's Value / threshold cell, and the value text in it. */
function valueCell(markup: string): { cell: string; value: string } {
  const cell = markup.match(/<span class="([^"]*)"><span class="[^"]*\bw-16\b/);
  const value = markup.match(/<span class="([^"]*)"><span class="text-muted-foreground">Count <\/span>/);
  if (!cell || !value) {
    throw new Error("no Value / threshold cell in the threshold row");
  }
  return { cell: cell[1]!, value: value[1]! };
}

// At a 1280px window the list is 1040px and the Value / threshold column is its
// 220px floor. "Count 3.79K / 2,000" beside the 64px bar and the FIRING badge
// is wider than that, and the cell did not wrap: FIRING was drawn over the Last
// fired column ("FIRING2026-10-17 09:15Z").
describe("the Alerts list's Value / threshold cell", () => {
  test("a firing row wraps FIRING under its value instead of drawing it over Last fired", () => {
    const markup = html(
      [{ ...base, last_fired_at: Date.parse("2026-10-17T09:15:00Z"), last_status: "200" }],
      { s1: { value: 3790, refused: false } },
    );
    expect(markup).toContain(">firing<");
    const { cell, value } = valueCell(markup);
    expect(cell).toMatch(/(?:^|\s)flex-wrap(?:\s|$)/);
    // The value itself may break too, so a long series name never runs past the column.
    expect(value).not.toMatch(/(?:^|\s)whitespace-nowrap(?:\s|$)/);
  });
});
