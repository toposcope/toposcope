import { expect, test } from "bun:test";
import { zoomKey } from "./zoom-key";

test("names ⌘ on a Mac and Ctrl elsewhere", () => {
  expect(zoomKey("MacIntel")).toBe("⌘");
  expect(zoomKey("Win32")).toBe("Ctrl");
  expect(zoomKey("Linux x86_64")).toBe("Ctrl");
});
