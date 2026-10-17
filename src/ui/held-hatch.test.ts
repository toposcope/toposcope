import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HeldHatch } from "./components/held-hatch";
import type { HeldGap } from "../shared/held";

const at = (t: string) => Date.parse(`2026-08-14T${t}Z`);
const hour = { fromMs: at("14:00:00"), plotSpanMs: 60 * 60_000 };
const sixHours = { fromMs: at("09:00:00"), plotSpanMs: 6 * 60 * 60_000 };

type Span = HeldGap & { label: string };

function hatch(spans: Span[], plot: { fromMs: number; plotSpanMs: number }): string {
  return renderToStaticMarkup(createElement(HeldHatch, { spans, ...plot }));
}

/** Each hatch's label: its words and its class. */
function labels(markup: string): Array<{ text: string; cls: string; style: string }> {
  return [...markup.matchAll(/<span class="([^"]*)"(?: style="([^"]*)")?>([^<]*)<\/span>/g)].map((m) => ({
    cls: m[1]!,
    style: m[2] ?? "",
    text: m[3]!,
  }));
}

const quiet = (from: string): Span => ({
  source: "prod-eu",
  kind: "quiet",
  from: at(from),
  to: at("15:00:00"),
  label: "no rows from prod-eu — not answering, not quiet",
});

// A span under 30% of the plot ends its label at the hatch's right edge. A long
// label then ran left out of the hatch, over the bars and the mark labels: five
// minutes of a quiet prod-eu in a 1h window drew "no rows from prod-eu — not
// answering, not quiet" across a third of the plot.
describe("a hatched span's label (#139, 5c, 5d, 5g)", () => {
  test("a narrow span too short for its sentence says only whose it is", () => {
    const narrow = labels(hatch([quiet("14:55:00")], hour));
    expect(narrow.map((l) => l.text)).toEqual(["prod-eu"]);
    // 5d: two hours of six keeps the whole sentence, inside the hatch.
    expect(labels(hatch([quiet("12:58:04")], sixHours)).map((l) => l.text)).toEqual([
      "no rows from prod-eu — not answering, not quiet",
    ]);
    // 5c: four minutes of an hour keeps "not here yet" at the hatch's right edge.
    const behind: Span = { source: "prod-eu", kind: "behind", from: at("14:56:02"), to: at("15:00:00"), label: "not here yet" };
    expect(labels(hatch([behind], hour)).map((l) => l.text)).toEqual(["not here yet"]);
    // 5g: several short spans each say whose they are.
    expect(labels(hatch([{ ...behind, label: "prod-eu" }], hour)).map((l) => l.text)).toEqual(["prod-eu"]);
  });

  test("a narrow span's label is cut with an ellipsis, not drawn over the bars", () => {
    const long: Span = {
      source: "checkout-eu-west-2-canary",
      kind: "behind",
      from: at("14:59:00"),
      to: at("15:00:00"),
      label: "checkout-eu-west-2-canary",
    };
    const [label] = labels(hatch([long], hour));
    expect(label?.cls).toMatch(/(?:^|\s)truncate(?:\s|$)/);
    expect(label?.style).toContain("max-width");
  });
});
