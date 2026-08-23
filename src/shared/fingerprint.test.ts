import { describe, expect, test } from "bun:test";
import { flattenAttrs } from "./attrs";
import { liftException } from "./exception";
import {
  computeFingerprint,
  fingerprintHexLength,
  stabilizeMessage,
  withFingerprint,
} from "./fingerprint";

const frames = [
  { file: "app.ts", function: "charge", in_app: true },
  { file: "lib.ts", function: "call" },
];

describe("stabilizeMessage", () => {
  test("folds ids, IPs, timestamps, and digit runs", () => {
    expect(
      stabilizeMessage(
        "user 550e8400-e29b-41d4-a716-446655440000 from 10.0.0.1 at 2026-08-23T12:00:00.500Z paid 42",
      ),
    ).toBe("user # from # at # paid #");
    expect(
      stabilizeMessage("trace 0123456789abcdef0123456789abcdef span 0123456789abcdef"),
    ).toBe("trace # span #");
  });
});

describe("computeFingerprint", () => {
  test("same type and in_app frames hash the same; message does not matter", () => {
    const a = computeFingerprint("error", "boom 1", {
      "exception.type": "RuntimeError",
      "exception.frames": frames,
    });
    const b = computeFingerprint("info", "boom 2", {
      "exception.type": "RuntimeError",
      "exception.frames": frames,
    });
    expect(a).toBeDefined();
    expect(a).toHaveLength(fingerprintHexLength);
    expect(a).toBe(b);
  });

  test("library frames are ignored when any frame is in_app", () => {
    const withLib = computeFingerprint("error", "x", {
      "exception.type": "Error",
      "exception.frames": frames,
    });
    const appOnly = computeFingerprint("error", "x", {
      "exception.type": "Error",
      "exception.frames": [{ file: "app.ts", function: "charge", in_app: true }],
    });
    const allLib = computeFingerprint("error", "x", {
      "exception.type": "Error",
      "exception.frames": [
        { file: "lib.ts", function: "call" },
        { file: "vendor.ts", function: "wrap" },
      ],
    });
    expect(withLib).toBe(appOnly);
    expect(allLib).not.toBe(withLib);
  });

  test("line numbers on raw frames do not change the hash after lift", () => {
    const a = computeFingerprint(
      "error",
      "x",
      liftException({
        "exception.type": "Error",
        "exception.frames": [{ file: "app.ts", function: "run", line: 10, column: 2 }],
      }),
    );
    const b = computeFingerprint(
      "error",
      "x",
      liftException({
        "exception.type": "Error",
        "exception.frames": [{ file: "app.ts", function: "run", line: 99 }],
      }),
    );
    expect(a).toBe(b);
  });

  test("without frames, error/fatal or a type uses stabilized message", () => {
    const a = computeFingerprint("error", "timeout id=9 from 1.2.3.4", {});
    const b = computeFingerprint("fatal", "timeout id=80 from 9.9.9.9", {});
    const typed = computeFingerprint("info", "timeout id=9 from 1.2.3.4", {
      "exception.type": "TimeoutError",
    });
    expect(a).toBe(b);
    expect(typed).not.toBe(a);
  });

  test("info/warn/debug without type or frames is skipped", () => {
    expect(computeFingerprint("info", "ok", { path: "/v1" })).toBeUndefined();
    expect(computeFingerprint("warn", "slow", undefined)).toBeUndefined();
    expect(computeFingerprint("debug", "trace", undefined)).toBeUndefined();
  });
});

describe("withFingerprint", () => {
  test("writes e1 first so flatten keeps it under the 50-key cap", () => {
    const attrs: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      attrs[`k${i}`] = "v";
    }
    const flat = flattenAttrs(
      withFingerprint("error", "boom", liftException(attrs)),
    );
    expect(flat.e1).toHaveLength(fingerprintHexLength);
    expect(Object.keys(flat)).toHaveLength(50);
  });

  test("replaces a sender e1", () => {
    const stamped = withFingerprint("error", "boom", { e1: "nope" });
    expect(stamped?.e1).toBeDefined();
    expect(stamped?.e1).not.toBe("nope");
  });
});
