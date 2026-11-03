import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Band, Busy, busyDim, Empty, Refused, Skeleton } from "./components/ui/states";

// Sheet 45, Patterns → Data states (#441): one rendering of each state, everywhere.
describe("data states", () => {
  const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

  test("Busy names the elapsed time and turns warn with one hint at 5s", () => {
    const quick = html(createElement(Busy, { elapsedMs: 1_200, onStop: () => {} }));
    expect(quick).toContain("Searching… 1.2s");
    expect(quick).not.toContain("narrow the window");
    const slow = html(createElement(Busy, { elapsedMs: 6_400, onStop: () => {} }));
    expect(slow).toContain("bg-warn-soft");
    expect(slow).toContain("narrow the window or add a service: filter");
    expect(slow).toContain(">Stop<");
  });

  test("the last paint dims to half while busy", () => {
    expect(busyDim).toContain("opacity-50");
  });

  test("Refused is warn, never danger, inline and as a block", () => {
    const inline = html(createElement(Refused, { reason: "too wide to count", count: true }));
    expect(inline).toContain("—");
    expect(inline).toContain("text-warn-fg");
    const block = html(createElement(Refused, { form: "block", title: "Too wide to count", reason: "Narrow the window." }));
    expect(block).toContain("text-warn-fg");
    expect(inline + block).not.toContain("danger");
  });

  test("Empty is a title, one line and at most one action", () => {
    const out = html(createElement(Empty, { title: "No events in this range.", line: "Widen the range or clear filters." }));
    expect(out).toContain("<p class=\"m-0 text-base font-medium\">No events in this range.</p>");
    expect(out).toContain("Widen the range or clear filters.");
  });

  test("Skeleton stops pulsing under reduced motion; Band sits on tokens", () => {
    expect(html(createElement(Skeleton, { kind: "block" }))).toContain("motion-reduce:animate-none");
    const band = html(createElement(Band, { tone: "warn", children: "Lost ClickHouse" }));
    expect(band).toContain("bg-warn-soft");
    expect(band).not.toMatch(/#[0-9a-f]{6}/);
  });
});
