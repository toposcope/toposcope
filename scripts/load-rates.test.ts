import { describe, expect, test } from "bun:test";
import { parseForMs, parseLiveArgs } from "./load-rates";

describe("parseLiveArgs", () => {
  test("defaults", () => {
    expect(parseLiveArgs([])).toEqual({
      logs: 20,
      metrics: 2,
      traces: 1,
      forMs: 0,
    });
  });

  test("equals and space flags", () => {
    expect(parseLiveArgs(["--logs=40", "--metrics", "0", "--traces=2", "--for", "12s"])).toEqual({
      logs: 40,
      metrics: 0,
      traces: 2,
      forMs: 12_000,
    });
  });

  test("accepts rates above the old caps and refuses all-zero", () => {
    expect(parseLiveArgs(["--logs=2001", "--metrics=500", "--traces=200"])).toEqual({
      logs: 2001,
      metrics: 500,
      traces: 200,
      forMs: 0,
    });
    expect(() => parseLiveArgs(["--logs=0", "--metrics=0", "--traces=0"])).toThrow(
      /at least one/,
    );
  });

  test("refuses unknown flags", () => {
    expect(() => parseLiveArgs(["--pods=1"])).toThrow(/unknown/);
  });
});

describe("parseForMs", () => {
  test("seconds, minutes, and ms", () => {
    expect(parseForMs("12s")).toBe(12_000);
    expect(parseForMs("1m")).toBe(60_000);
    expect(parseForMs("2500ms")).toBe(2500);
    expect(parseForMs("8")).toBe(8000);
  });
});
