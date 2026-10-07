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

  test("a traceback of 50 frames or fewer keeps every frame, in the order printed", () => {
    const short = [
      "Traceback (most recent call last):",
      '  File "/app/api.py", line 88, in process_payment',
      "    charge()",
      '  File "/app/billing.py", line 41, in charge',
      '    raise ValueError("declined")',
      "ValueError: declined",
    ].join("\n");
    expect(
      liftException({ "exception.type": "ValueError", "exception.stacktrace": short })?.[
        "exception.frames"
      ],
    ).toEqual([
      { file: "/app/api.py", function: "process_payment" },
      { file: "/app/billing.py", function: "charge" },
    ]);
  });

  test("a format that prints the raise first still keeps its first 50 frames", () => {
    const deep = [
      "Error: declined",
      "    at charge (/app/src/billing.js:41:9)",
      ...Array.from({ length: 60 }, (_, i) => `    at layer${i} (/app/src/stack.js:${i + 1}:3)`),
    ].join("\n");
    const frames = liftException({ "exception.type": "Error", "exception.stacktrace": deep })?.[
      "exception.frames"
    ] as ExceptionFrame[];
    expect(frames).toHaveLength(50);
    expect(frames[0]).toEqual({ file: "/app/src/billing.js", function: "charge" });
    expect(frames.at(-1)?.function).toBe("layer48");
  });
});
