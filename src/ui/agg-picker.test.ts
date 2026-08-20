import { describe, expect, test } from "bun:test";
import {
  aggFromOpSelect,
  aggFromSeriesSelect,
  applySeriesSelect,
  maxNumericPickerKeys,
  northStarNumericKey,
  pickerMetricNames,
  pickerNumericKeys,
  seriesPickFromAgg,
  seriesPickFromWidget,
  seriesPickerOptions,
  seriesSelectValue,
} from "./agg-picker";

describe("pickerNumericKeys", () => {
  test("pins duration_ms first and caps at 8", () => {
    const discovered = [
      "status",
      "duration_ms",
      ...Array.from({ length: 10 }, (_, i) => `k${i}`),
    ];
    const keys = pickerNumericKeys(discovered, null);
    expect(keys[0]).toBe(northStarNumericKey);
    expect(keys).toHaveLength(maxNumericPickerKeys);
    expect(keys).toContain("status");
    expect(keys).not.toContain("k8");
  });

  test("keeps the URL key even when it is outside the top 8", () => {
    const discovered = Array.from({ length: 10 }, (_, i) => `k${i}`);
    const keys = pickerNumericKeys(discovered, "sum:outside");
    expect(keys).toHaveLength(maxNumericPickerKeys);
    expect(keys.at(-1)).toBe("outside");
  });

  test("falls back to duration_ms when the endpoint is empty", () => {
    expect(pickerNumericKeys([], null)).toEqual([northStarNumericKey]);
    expect(pickerNumericKeys([], "rate")).toEqual([northStarNumericKey]);
  });
});

describe("series pick round-trip", () => {
  test("Off / Rate / key+op", () => {
    expect(seriesPickFromAgg(null)).toEqual({ kind: "off" });
    expect(seriesPickFromAgg("rate")).toEqual({ kind: "rate" });
    expect(seriesPickFromAgg("sum:status")).toEqual({
      kind: "key",
      key: "status",
      op: "sum",
    });
    expect(seriesSelectValue({ kind: "off" })).toBe("");
    expect(seriesSelectValue({ kind: "rate" })).toBe("rate");
    expect(
      seriesSelectValue({ kind: "key", key: "duration_ms", op: "p99" }),
    ).toBe("k:duration_ms");
  });

  test("switching key keeps the op; Off/Rate default to p99", () => {
    const prev = seriesPickFromAgg("avg:status");
    expect(aggFromSeriesSelect("", prev)).toBeNull();
    expect(aggFromSeriesSelect("rate", prev)).toBe("rate");
    expect(aggFromSeriesSelect("k:duration_ms", prev)).toBe("avg:duration_ms");
    expect(aggFromSeriesSelect("k:duration_ms", { kind: "off" })).toBe(
      "p99:duration_ms",
    );
    expect(aggFromOpSelect("min", prev)).toBe("min:status");
    expect(aggFromOpSelect("min", { kind: "rate" })).toBeNull();
  });

  test("metric options sit beside log series", () => {
    expect(seriesPickFromWidget(null, "cpu_seconds")).toEqual({
      kind: "metric",
      name: "cpu_seconds",
    });
    expect(seriesSelectValue({ kind: "metric", name: "cpu_seconds" })).toBe(
      "m:cpu_seconds",
    );
    expect(applySeriesSelect("m:cpu_seconds", { kind: "off" })).toEqual({
      agg: null,
      metric: "cpu_seconds",
    });
    expect(applySeriesSelect("rate", { kind: "metric", name: "cpu_seconds" })).toEqual({
      agg: "rate",
      metric: null,
    });
    expect(pickerMetricNames(["cpu_seconds", "mem_bytes"], null)).toEqual([
      "cpu_seconds",
      "mem_bytes",
    ]);
    expect(pickerMetricNames([], "cpu_seconds")).toEqual(["cpu_seconds"]);
    expect(pickerMetricNames([], null)).toEqual([]);
  });

  test("seriesPickerOptions lists Count, Rate, keys, then metrics", () => {
    expect(
      seriesPickerOptions(["duration_ms"], ["cpu_seconds"], "p99:duration_ms", null),
    ).toEqual([
      { value: "", label: "Count" },
      { value: "rate", label: "Rate" },
      { value: "k:duration_ms", label: "duration_ms" },
      { value: "m:cpu_seconds", label: "cpu_seconds" },
    ]);
  });
});
