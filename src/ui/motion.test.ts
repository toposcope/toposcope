import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "./components/ui/button";
import { overlayMotion, tooltipDelayMs } from "./components/ui/motion";

// Sheet 45, Tokens → Motion (#446): controls move; data never does.
describe("motion", () => {
  test("three durations, and reduced motion sets them to 0", () => {
    const css = readFileSync("src/ui/styles.css", "utf8");
    expect(css).toContain("--d1: 90ms;");
    expect(css).toContain("--d2: 150ms;");
    expect(css).toContain("--d3: 220ms;");
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced.slice(0, reduced.indexOf("}\n}"))).toMatch(/--d1: 0ms;[\s\S]*--d2: 0ms;[\s\S]*--d3: 0ms;/);
  });

  test("a busy Button keeps focus: aria-busy and a spinner, never disabled", () => {
    const html = renderToStaticMarkup(createElement(Button, { busy: true }, "Save hunt"));
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("animate-spin");
    expect(html).not.toMatch(/<button[^>]*\sdisabled(=""|\s|>)/);
    expect(renderToStaticMarkup(createElement(Button, null, "Save"))).toContain("active:scale-97");
  });

  test("menus scale from 0.97 at their anchor; tooltips wait 400ms", () => {
    expect(overlayMotion).toContain("zoom-in-97");
    expect(tooltipDelayMs).toBe(400);
  });
});
