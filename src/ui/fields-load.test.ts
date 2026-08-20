import { describe, expect, test } from "bun:test";
import {
  FIELDS_SLOW_AFTER_MS,
  FIELDS_SLOW_MIN_SPAN_MS,
  fieldsCatalogSlow,
  fieldsSlowAdvice,
  fieldsWaveLabel,
} from "./fields-load";

describe("fields catalog load chrome", () => {
  test("names the wave and stays quiet on a short window", () => {
    expect(fieldsWaveLabel("keys")).toBe("Counting keys");
    expect(fieldsWaveLabel("values")).toBe("Counting distinct values");
    expect(fieldsWaveLabel("suggest")).toBe("Checking metric labels");
    expect(fieldsCatalogSlow(60 * 60 * 1000, 8_000, "values")).toBe(false);
    expect(
      fieldsCatalogSlow(FIELDS_SLOW_MIN_SPAN_MS, FIELDS_SLOW_AFTER_MS, "values"),
    ).toBe(false);
    expect(
      fieldsCatalogSlow(
        7 * 24 * 60 * 60 * 1000,
        FIELDS_SLOW_AFTER_MS + 1,
        "values",
      ),
    ).toBe(true);
    expect(fieldsSlowAdvice("7d", 15)).toBe(
      "7d over 15 keys — a narrower range returns sooner",
    );
    expect(fieldsSlowAdvice("7d", 0)).toBe(
      "7d — a narrower range returns sooner",
    );
  });
});
