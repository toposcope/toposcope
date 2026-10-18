import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WidgetCanvas } from "./components/widget-canvas";
import { SeriesPicker } from "./components/series-picker";
import { TooltipProvider } from "./components/ui/tooltip";
import { midCut } from "./series-list";
import { defaultTimeseries } from "../shared/widgets";

// agental's board "Disk · all boxes" (2026-10-18): four metric panels about 880px wide, each
// titled by a cut of a fixed 18 characters. `agental.box.stranded.disk` read `agental.box…disk`,
// which is the disk metric itself; the one word that told the panel apart was the word cut.
// A title is cut to the room its panel gives it, and a cut never reads as another name.

const board = [
  "agental.box.disk",
  "agental.box.stranded.disk",
  "agental.box.disk.sold",
  "agental.box.fits.small",
];
const stranded = "agental.box.stranded.disk";
const others = (name: string) => board.filter((other) => other !== name);

/** A cut `head…tail` reads as any other name that starts with its head and ends with its tail. */
function readsAs(cut: string, other: string): boolean {
  const at = cut.indexOf("…");
  if (at < 0) {
    return cut === other;
  }
  const head = cut.slice(0, at);
  const tail = cut.slice(at + 1);
  return other.length >= head.length + tail.length && other.startsWith(head) && other.endsWith(tail);
}

/** What a person reads: the markup without what is hidden from them, and without tags. */
function shown(html: string): string {
  return html
    .replace(/<span[^>]*aria-hidden="true"[^>]*>[^<]*<\/span>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&quot;", '"')
    .replace(/\s+/g, " ");
}

function canvas(metric: string): string {
  const pinned = defaultTimeseries({});
  const panel = { ...defaultTimeseries({}), id: "b", y: 3, w: 12, metric };
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(WidgetCanvas, {
        widgets: [pinned, panel],
        logs: true,
        onWidgets: () => {},
        onLogs: () => {},
        series: {},
        loading: false,
        live: false,
        numericKeys: [],
        metricNames: board,
        attrKeys: [],
        spanMs: 3_600_000,
        interval: null,
        onInterval: () => {},
        onWindow: () => {},
      }),
    ),
  );
}

describe("a metric panel's title is cut to its panel, not to 18 characters", () => {
  test("the title of a wide panel shows the whole name", () => {
    const text = shown(canvas(stranded));
    expect(text).not.toContain("agental.box…disk");
    expect(text).toContain(`avg · ${stranded}`);
  });

  test("an 880px panel has room for the whole name", async () => {
    const { cutToRoom } = await import("./series-list");
    // 11.5px monospace is about 6.9px a character; the head keeps about 200px for its buttons.
    expect(cutToRoom(stranded, 680, 6.9, { lead: "avg · ", others: others(stranded) })).toBe(stranded);
  });

  test("a narrow panel cuts to its width, not to 18", async () => {
    const { cutToRoom } = await import("./series-list");
    const px = 6.9;
    // Room for 14 characters: the 18-character cut (`agental.box…disk`, 16) would not fit.
    const narrow = cutToRoom(stranded, 14 * px, px);
    expect(narrow.length).toBeLessThanOrEqual(14);
    expect(narrow).not.toBe(midCut(stranded, 18));
    // The lead (`avg · `) shares the room.
    expect(`avg · ${cutToRoom(stranded, 20 * px, px, { lead: "avg · " })}`.length).toBeLessThanOrEqual(20);
    // Room for 22: more of the name than 18 characters' worth, and still within the room.
    const wider = cutToRoom(stranded, 22 * px, px, { others: others(stranded) });
    expect(wider.length).toBeLessThanOrEqual(22);
    expect(wider.length).toBeGreaterThan(midCut(stranded, 18).length);
    // Room for the whole name is the whole name.
    expect(cutToRoom(stranded, 25 * px, px)).toBe(stranded);
  });

  test("labels after the name are never cut; only the name gives up room", async () => {
    const { cutToRoom } = await import("./series-list");
    const px = 6.9;
    const trail = "{box=host-03}";
    const cut = cutToRoom(stranded, 30 * px, px, { trail, others: others(stranded) });
    expect(`${cut}${trail}`.length).toBeLessThanOrEqual(30);
    expect(cut).toContain("…");
    expect(cut.endsWith("disk")).toBe(true);
  });
});

describe("two names differing only in a middle segment never read alike", () => {
  test("`agental.box.stranded.disk` never reads as `agental.box.disk`", () => {
    for (let max = 7; max < stranded.length; max += 1) {
      const cut = midCut(stranded, max, others(stranded));
      expect(cut.length).toBeLessThanOrEqual(max);
      for (const other of others(stranded)) {
        expect([max, other, readsAs(cut, other)]).toEqual([max, other, false]);
      }
    }
  });

  test("two panels cut to the same room read differently", () => {
    const a = "svc.api.read.latency";
    const b = "svc.api.write.latency";
    for (let max = 10; max < a.length; max += 1) {
      const ca = midCut(a, max, [b]);
      const cb = midCut(b, max, [a]);
      expect([max, ca === cb]).toEqual([max, false]);
      expect([max, readsAs(ca, b), readsAs(cb, a)]).toEqual([max, false, false]);
    }
  });

  test("the board's own names, cut at 16, read as four different panels", () => {
    const cuts = board.map((name) => midCut(name, 16, others(name)));
    expect(new Set(cuts).size).toBe(board.length);
    cuts.forEach((cut, i) => {
      for (const other of others(board[i]!)) {
        expect([cut, other, readsAs(cut, other)]).toEqual([cut, other, false]);
      }
    });
  });
});

describe("the Series control and the hover are not cut by a count either", () => {
  function picker(variant: "footer" | "head"): string {
    return renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(SeriesPicker, {
          variant,
          card: true,
          pick: { kind: "metric", name: stranded },
          agg: null,
          view: { name: stranded, kind: "gauge", reading: null },
          onSeries: () => {},
        }),
      ),
    );
  }

  test("a picked metric in a card's footer is whole until its room is measured", () => {
    expect(shown(picker("footer"))).toContain(stranded);
  });

  test("a picked metric on a Stat card's head is whole until its room is measured", () => {
    expect(shown(picker("head"))).toContain(stranded);
  });

  test("the hover names the metric and its labels whole; the card cuts them to its room", async () => {
    const { metricHoverLabel } = await import("./components/histogram-chart");
    const row = metricHoverLabel({ name: stranded, kind: "gauge", reading: null }, { box: "host-03" });
    expect(row).toEqual({ name: stranded, label: `${stranded}{box=host-03}` });
  });
});
