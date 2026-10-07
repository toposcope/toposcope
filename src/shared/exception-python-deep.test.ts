import { describe, expect, test } from "bun:test";
import { liftException, type ExceptionFrame } from "./exception";
import { computeFingerprint } from "./fingerprint";

type Site = { file: string; fn: string };

/** Python prints the outermost call first; the raise site is the last frame. */
function traceback(raise: Site): string {
  const outer = Array.from({ length: 52 }, (_, i) => {
    const n = String(i).padStart(2, "0");
    return `  File "/app/server/middleware_${n}.py", line ${10 + i}, in call_${n}\n    return handler(request)`;
  });
  return [
    "Traceback (most recent call last):",
    ...outer,
    `  File "${raise.file}", line 41, in ${raise.fn}`,
    '    raise ValueError("declined")',
    "ValueError: declined",
  ].join("\n");
}

function lifted(raise: Site): Record<string, unknown> | undefined {
  return liftException({
    "exception.type": "ValueError",
    "exception.stacktrace": traceback(raise),
  });
}

const charge: Site = { file: "/app/billing/charge.py", fn: "charge" };
const refund: Site = { file: "/app/billing/refund.py", fn: "refund" };

describe("deep Python traceback", () => {
  test("keeps the frame that raised", () => {
    const frames = lifted(charge)?.["exception.frames"] as ExceptionFrame[];
    expect(frames).toContainEqual({ file: charge.file, function: charge.fn });
  });

  test("two raise sites under the same 52 outer frames get different e1", () => {
    const a = computeFingerprint("error", "declined", lifted(charge));
    const b = computeFingerprint("error", "declined", lifted(refund));
    expect(a).not.toBe(b);
  });
});
