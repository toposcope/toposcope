import { describe, expect, test } from "bun:test";
import { addHbar, addStat, defaultLayout, patchWidget } from "../shared/widgets";
import {
  rankHeadOptions,
  usedCanvasFieldValues,
  usedCanvasSeriesValues,
} from "./head-query";

describe("rankHeadOptions", () => {
  test("sinks values already on the canvas and leaves the selection unmarked", () => {
    const ranked = rankHeadOptions(
      [
        { value: "status", label: "status" },
        { value: "path", label: "path" },
        { value: "level", label: "level" },
      ],
      "status",
      ["status", "path"],
    );
    expect(ranked.map((item) => item.value)).toEqual(["status", "level", "path"]);
    expect(ranked.find((item) => item.value === "status")?.used).toBe(false);
    expect(ranked.find((item) => item.value === "path")?.used).toBe(true);
  });
});

describe("used on canvas", () => {
  test("series skips Top-N and fields include every other card", () => {
    let widgets = addStat(defaultLayout().widgets);
    widgets = addHbar(widgets);
    widgets = patchWidget(widgets, "b", { agg: "p99:duration_ms" });
    widgets = patchWidget(widgets, "c", { attr: "status" });
    expect(usedCanvasSeriesValues(widgets, "c")).toEqual(["", "k:duration_ms"]);
    expect(usedCanvasFieldValues(widgets, "c")).toEqual(["level", "level"]);
    expect(usedCanvasFieldValues(widgets, "b")).toEqual(["level", "status"]);
  });
});
