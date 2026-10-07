import { describe, expect, test } from "bun:test";
import { liftException } from "./exception";
import { parseExceptionStacktrace } from "./exception-stacktrace";
import { computeFingerprint } from "./fingerprint";

/** V8 prints an anonymous async frame as `at async <path>:line:col`. */
function e1(frameLine: string): string | undefined {
  const attrs = liftException({
    "exception.type": "Error",
    "exception.stacktrace": `Error: payment failed\n    ${frameLine}`,
  });
  return computeFingerprint("error", "payment failed", attrs);
}

describe("Node `at async <path>` frame", () => {
  test("parses the file without the async keyword", () => {
    expect(
      parseExceptionStacktrace("Error: payment failed\n    at async /app/src/pay.js:12:5", 50),
    ).toEqual([{ file: "/app/src/pay.js", function: "" }]);
  });

  test("one error keeps one e1 across deploy directories", () => {
    expect(e1("at async /usr/src/app/src/pay.js:12:5")).toBe(e1("at async /app/src/pay.js:12:5"));
  });

  test("is fingerprinted like the same frame without async", () => {
    expect(e1("at async /app/src/pay.js:12:5")).toBe(e1("at /app/src/pay.js:12:5"));
  });
});
