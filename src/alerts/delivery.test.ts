import { describe, expect, test } from "bun:test";
import {
  clipError,
  nextDelivery,
  nextEvalAttempt,
  outcomeFromError,
  outcomeFromHttp,
} from "./delivery";

describe("webhook outcome", () => {
  test("2xx is success", () => {
    expect(outcomeFromHttp(204, "No Content")).toEqual({
      ok: true,
      status: "204",
      error: null,
    });
  });

  test("non-2xx keeps the status code", () => {
    expect(outcomeFromHttp(404, "Not Found")).toEqual({
      ok: false,
      status: "404",
      error: "Not Found",
    });
  });

  test("abort is timeout", () => {
    const err = new Error("The operation was aborted.");
    err.name = "AbortError";
    expect(outcomeFromError(err)).toEqual({
      ok: false,
      status: "timeout",
      error: "webhook timed out",
    });
  });

  test("other errors stay as error", () => {
    expect(outcomeFromError(new Error("fetch failed"))).toEqual({
      ok: false,
      status: "error",
      error: "fetch failed",
    });
  });

  test("clips long error text", () => {
    expect(clipError(`  ${"x".repeat(250)}  `).length).toBe(200);
  });
});

describe("nextDelivery", () => {
  test("success clears failures and sets last_fired_at", () => {
    expect(
      nextDelivery(
        {
          last_fired_at: 10,
          consecutive_failures: 4,
          last_status: "404",
          last_error: "Not Found",
        },
        { at: 50, ok: true, status: "200", error: null },
      ),
    ).toEqual({
      last_attempt_at: 50,
      last_status: "200",
      last_error: null,
      consecutive_failures: 0,
      last_fired_at: 50,
    });
  });

  test("failure increments consecutive_failures and keeps last_fired_at", () => {
    expect(
      nextDelivery(
        {
          last_fired_at: 10,
          consecutive_failures: 2,
          last_status: "200",
          last_error: null,
        },
        { at: 50, ok: false, status: "404", error: "Not Found" },
      ),
    ).toEqual({
      last_attempt_at: 50,
      last_status: "404",
      last_error: "Not Found",
      consecutive_failures: 3,
      last_fired_at: 10,
    });
  });
});

describe("nextEvalAttempt", () => {
  const prev = {
    last_fired_at: 10,
    consecutive_failures: 0,
    last_status: "200" as string | null,
    last_error: null as string | null,
  };

  test("refused stamps last_status and does not touch last_fired_at", () => {
    expect(
      nextEvalAttempt(prev, {
        at: 50,
        status: "refused",
        error: "p99/avg over this query exceeds the scan budget",
      }),
    ).toEqual({
      last_attempt_at: 50,
      last_status: "refused",
      last_error: "p99/avg over this query exceeds the scan budget",
      consecutive_failures: 0,
      last_fired_at: 10,
    });
  });

  test("eval error is not refused and does not increment POST failures", () => {
    expect(
      nextEvalAttempt(
        { ...prev, consecutive_failures: 2 },
        { at: 50, status: "error", error: "ClickHouse query failed" },
      ),
    ).toMatchObject({
      last_status: "error",
      consecutive_failures: 2,
      last_fired_at: 10,
    });
  });

  test("quiet success clears a previous refuse", () => {
    expect(
      nextEvalAttempt(
        {
          last_fired_at: 10,
          consecutive_failures: 0,
          last_status: "refused",
          last_error: "p99/avg need a numeric field",
        },
        { at: 50, status: "ok", error: null },
      ),
    ).toEqual({
      last_attempt_at: 50,
      last_status: null,
      last_error: null,
      consecutive_failures: 0,
      last_fired_at: 10,
    });
  });

  test("quiet success keeps a webhook HTTP failure", () => {
    expect(
      nextEvalAttempt(
        {
          last_fired_at: 10,
          consecutive_failures: 3,
          last_status: "404",
          last_error: "Not Found",
        },
        { at: 50, status: "ok", error: null },
      ),
    ).toMatchObject({
      last_status: "404",
      last_error: "Not Found",
      consecutive_failures: 3,
      last_fired_at: 10,
    });
  });
});
