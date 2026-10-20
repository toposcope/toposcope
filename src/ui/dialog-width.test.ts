import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// A minted link key is one unbroken 200-character word. In a dialog it must be cut to its field
// (frame 7a: `tsl1_o.ZWRnZS1mcmE.aHR0cHM6…`), not push the filter, the key and the direction strip
// out past the dialog's edge.
const dialog = readFileSync("src/ui/components/ui/dialog.tsx", "utf8");

describe("a dialog is as wide as it says, whatever it holds", () => {
  test("its content's one grid column may shrink below the widest word in it", () => {
    // The content is a CSS grid. Its implicit column is `auto`, whose minimum is the widest
    // unbreakable text inside, so a long key widened the column past `max-w-[480px]`.
    const content = dialog.slice(dialog.indexOf("<DialogPrimitive.Content"), dialog.indexOf("</DialogPrimitive.Content>"));
    expect(content).toContain("grid-cols-[minmax(0,1fr)]");
  });
});
