import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

// docs/ui (#448): one page per primitive and pattern, each in the sheet's shape, linked from the README.
const pages = ["button", "split-button", "input", "chip", "badge", "tabs", "switch", "menu", "tooltip", "toast", "skeleton", "busy", "refused", "empty", "live-age", "band", "panel", "dialog", "sheet", "armed", "command-palette"];

describe("docs/ui", () => {
  const readme = readFileSync("docs/ui/README.md", "utf8");

  test.each(pages)("%s has its page, in the sheet's shape, linked from the README", (page) => {
    const path = `docs/ui/${page}.md`;
    expect(existsSync(path)).toBe(true);
    const body = readFileSync(path, "utf8");
    for (const heading of ["## Props", "## Use", "## Do not", "## Keys and access", "## Motion"]) {
      expect(body).toContain(heading);
    }
    expect(readme).toContain(`(${page}.md)`);
  });

  test("the README carries the tokens, contrast, motion, terms and the ratchet", () => {
    for (const heading of ["## Tokens", "## Motion", "## Words", "## Contrast", "## Focus", "## Lint ratchet"]) {
      expect(readme).toContain(heading);
    }
  });
});
