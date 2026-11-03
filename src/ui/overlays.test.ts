import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Armed } from "./components/ui/armed";
import { Sheet } from "./components/ui/sheet";

// Sheet 45, Patterns → Overlays and side panels (#443).
describe("overlays", () => {
  test("dialogs come in three widths and one footer", () => {
    const dialog = readFileSync("src/ui/components/ui/dialog.tsx", "utf8");
    expect(dialog).toContain("min(440px,");
    expect(dialog).toContain("min(640px,");
    expect(dialog).toContain("min(1080px,");
    expect(dialog).toMatch(/function DialogFooter[\s\S]*?justify-end/);
    for (const file of ["save-search-dialog.tsx", "board-name-dialog.tsx"]) {
      const src = readFileSync(`src/ui/components/${file}`, "utf8");
      const footer = src.slice(src.indexOf("<DialogFooter>"), src.indexOf("</DialogFooter>"));
      // Cancel first, the one primary last.
      expect(footer.indexOf("Cancel")).toBeLessThan(footer.indexOf('type="submit"'));
    }
  });

  test("Armed confirms in place: label, then the armed words in danger", () => {
    const props = { onArm: () => {}, onDisarm: () => {}, onConfirm: () => {}, label: "revoke", confirm: "sure? revoke" };
    expect(renderToStaticMarkup(createElement(Armed, { ...props, armed: false }))).toContain(">revoke<");
    const armed = renderToStaticMarkup(createElement(Armed, { ...props, armed: true }));
    expect(armed).toContain(">sure? revoke<");
    expect(armed).toContain("text-danger-fg");
  });

  test("one Sheet: top is a modal dialog, bottom leaves the page live", () => {
    const top = renderToStaticMarkup(createElement(Sheet, { side: "top", label: "Invite someone", width: 900, onClose: () => {}, children: "x" }));
    expect(top).toContain('role="dialog"');
    expect(top).toContain("bg-black/55");
    const bottom = renderToStaticMarkup(createElement(Sheet, { side: "bottom", label: "Watch this", onClose: () => {}, children: "x" }));
    expect(bottom).toContain('role="region"');
    expect(bottom).not.toContain("bg-black/55");
  });
});
