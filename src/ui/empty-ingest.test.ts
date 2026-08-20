import { describe, expect, test } from "bun:test";
import { isEmptyIngest, nextIngested } from "./empty-ingest";

describe("isEmptyIngest", () => {
  test("is the ingest empty copy only when the store has no rows", () => {
    expect(
      isEmptyIngest({
        searching: false,
        error: null,
        eventCount: 0,
        q: "",
        ingested: false,
      }),
    ).toBe(true);
    expect(
      isEmptyIngest({
        searching: false,
        error: null,
        eventCount: 0,
        q: "",
        ingested: true,
      }),
    ).toBe(false);
  });

  test("stays off while searching, on error, with a query, or with rows", () => {
    const base = {
      searching: false,
      error: null,
      eventCount: 0,
      q: "",
      ingested: false,
    };
    expect(isEmptyIngest({ ...base, searching: true })).toBe(false);
    expect(isEmptyIngest({ ...base, error: "failed" })).toBe(false);
    expect(isEmptyIngest({ ...base, q: "level:error" })).toBe(false);
    expect(isEmptyIngest({ ...base, eventCount: 1 })).toBe(false);
  });
});

describe("nextIngested", () => {
  test("latches true from the flag, events, or histogram", () => {
    expect(
      nextIngested(false, "replace", {
        ingested: true,
        events: [],
        histogramTotal: 0,
      }),
    ).toBe(true);
    expect(
      nextIngested(false, "append", {
        events: [{}],
        histogramTotal: 0,
      }),
    ).toBe(true);
    expect(
      nextIngested(false, "poll", {
        events: [],
        histogramTotal: 4,
      }),
    ).toBe(true);
  });

  test("clears only on a replace that says the store is empty", () => {
    expect(
      nextIngested(true, "replace", {
        ingested: false,
        events: [],
        histogramTotal: 0,
      }),
    ).toBe(false);
    expect(
      nextIngested(true, "poll", {
        events: [],
        histogramTotal: 0,
      }),
    ).toBe(true);
    expect(
      nextIngested(true, "append", {
        ingested: false,
        events: [],
        histogramTotal: 0,
      }),
    ).toBe(true);
  });
});
