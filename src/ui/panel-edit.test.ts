import { describe, expect, test } from "bun:test";
import { defaultTimeseries, widgetTitle } from "../shared/widgets";
import { canJoin, withLine, withLineName, withoutLine } from "./panel-edit";

// #169, frames 17c–17e and 17i: what the panel editor changes.
const disk = defaultTimeseries({
  id: "b",
  replaceY: true,
  metric: "agental.box.disk.sellable",
  metricLabels: { box: "all" },
  lines: [
    { metric: "agental.box.disk.sold", labels: { box: "all" } },
    { metric: "agental.box.disk.used", labels: { box: "all" } },
  ],
  names: { "0": "Capacity", "1": "Promised", "2": "In use" },
});

describe("the panel editor", () => {
  test("only a metric of the panel's unit can join; one not sent yet has no unit to refuse (17c, 17e)", () => {
    expect(canJoin("GiBy", "GiBy")).toBe(true);
    expect(canJoin("GiBy", "{vcpu}")).toBe(false);
    expect(canJoin("GiBy", undefined)).toBe(true);
    expect(canJoin(null, "{vcpu}")).toBe(true);
  });

  test("removing a line moves the names after it up with their lines", () => {
    expect(withoutLine(disk, 1)).toEqual({
      lines: [{ metric: "agental.box.disk.used", labels: { box: "all" } }],
      names: { "0": "Capacity", "1": "In use" },
    });
  });

  test("a name is cut at 24 characters, and a blank one is taken away (17d)", () => {
    expect(withLineName({}, "1", "Promised to sandboxes on every box")).toEqual({ "1": "Promised to sandboxes on" });
    expect(withLineName({ "0": "Capacity", "1": "Promised" }, "1", "  ")).toEqual({ "0": "Capacity" });
  });

  test("adding a line to a split panel makes it merge, and drops the split's value names (17i)", () => {
    const split = defaultTimeseries({ id: "c", metric: "agental.box.stranded.disk", metricSplit: "basis", names: { sold: "By promises" } });
    expect(withLine(split, "agental.box.disk.sold")).toEqual({
      lines: [{ metric: "agental.box.disk.sold", labels: {} }],
      metricSplit: null,
      names: {},
    });
    expect(withLine(disk, "agental.box.disk.free").names).toEqual(disk.names!);
  });

  test("a title it was given wins over the one it makes (17d)", () => {
    expect(widgetTitle({ ...disk, title: "Disk, all boxes" })).toBe("Disk, all boxes");
    expect(widgetTitle(disk)).not.toBe("Disk, all boxes");
  });
});
