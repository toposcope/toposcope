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

  test("deployment release directories do not make an existing error a new fingerprint", () => {
    const attrs = (file: string) => ({
      "exception.type": "TypeError",
      "exception.frames": [{ file, function: "charge", in_app: true }],
    });
    const before = computeFingerprint(
      "error",
      "payment failed",
      attrs("/var/www/releases/2026-10-05/src/billing/charge.ts"),
    );
    const after = computeFingerprint(
      "error",
      "payment failed",
      attrs("/var/www/releases/2026-10-06/src/billing/charge.ts"),
    );
    expect(after).toBe(before);
  });

  test.each([
    "/app/billing/charge.ts",
    "/src/billing/charge.ts",
    "/usr/src/app/billing/charge.ts",
    "/var/www/billing/charge.ts",
    "/var/www-prod/billing/charge.ts",
    "/home/alice/billing/charge.ts",
  ])("deployment root %s does not change the source-file fingerprint", (file) => {
    const hash = (path: string) => computeFingerprint("error", "payment failed", {
      "exception.type": "TypeError",
      "exception.frames": [{ file: path, function: "charge" }],
    });
    expect(hash(file)).toBe(hash("billing/charge.ts"));
  });

  test("different build roots use the same final three source-file segments", () => {
    const hash = (file: string) => computeFingerprint("error", "payment failed", {
      "exception.type": "TypeError",
      "exception.frames": [{ file, function: "charge" }],
    });
    expect(hash("/opt/runner/build-101/src/billing/charge.ts"))
      .toBe(hash("/tmp/checkout/build-202/src/billing/charge.ts"));
  });

  test("a known deployment root and a deep relative source path share a fingerprint", () => {
    const hash = (file: string) => computeFingerprint("error", "payment failed", {
      "exception.type": "TypeError",
      "exception.frames": [{ file, function: "charge" }],
    });
    expect(hash("/app/billing/handlers/v1/charge.ts"))
      .toBe(hash("billing/handlers/v1/charge.ts"));
  });

  test("deep relative source paths retain their leading source-directory identity", () => {
    const hash = (file: string) => computeFingerprint("error", "payment failed", {
      "exception.type": "TypeError",
      "exception.frames": [{ file, function: "charge" }],
    });
    expect(hash("billing/handlers/v1/charge.ts"))
      .not.toBe(hash("orders/handlers/v1/charge.ts"));
  });

  test("Windows and slash-separated source paths have the same fingerprint", () => {
    const hash = (file: string) => computeFingerprint("error", "payment failed", {
      "exception.type": "TypeError",
      "exception.frames": [{ file, function: "charge" }],
    });
    expect(hash("C:\\work\\project\\src\\billing\\charge.ts"))
      .toBe(hash("/opt/project/src/billing/charge.ts"));
  });

  test("line and column suffixes inside frame file strings do not change the fingerprint", () => {
    const hash = (file: string) => computeFingerprint("error", "payment failed", {
      "exception.type": "TypeError",
      "exception.frames": [{ file, function: "charge" }],
    });
    expect(hash("billing/charge.ts:41:9")).toBe(hash("billing/charge.ts:88:2"));
  });

  test("stacktrace-only exception frames group the same error across different log bodies", () => {
    const attrs = liftException({
      "exception.type": "TypeError",
      "exception.stacktrace": "TypeError: payment failed\n    at charge (/app/billing.ts:41:9)",
    });
    expect(computeFingerprint("error", "payment failed", attrs))
      .toBe(computeFingerprint("error", "request failed", attrs));
  });

  test("stacktrace-only exception frames distinguish different errors with the same log body", () => {
    const hash = (stacktrace: string) => computeFingerprint("error", "request failed", liftException({
      "exception.type": "TypeError",
      "exception.stacktrace": stacktrace,
    }));
    expect(hash("TypeError: failed\n    at charge (/app/billing.ts:41:9)"))
      .not.toBe(hash("TypeError: failed\n    at cancel (/app/orders.ts:88:2)"));
  });

  test("unknown stacktrace keeps the stabilized log-body fingerprint", () => {
    const plain = { "exception.type": "TypeError" };
    const unknown = liftException({ ...plain, "exception.stacktrace": "an unsupported stack representation" });
    expect(computeFingerprint("error", "request 101 failed", unknown))
      .toBe(computeFingerprint("error", "request 202 failed", plain));
  });

  test("a stack-looking log body is not parsed without an exception.stacktrace attribute", () => {
    const type = { "exception.type": "TypeError" };
    const a = "TypeError: failed\n    at charge (/app/billing.ts:41:9)";
    const b = "TypeError: failed\n    at cancel (/app/orders.ts:88:2)";
    expect(computeFingerprint("error", a, liftException(type)))
      .not.toBe(computeFingerprint("error", b, liftException(type)));
  });

  test("hash path normalization keeps original exception paths and other attrs", () => {
    const original = {
      "exception.type": "TypeError",
      "exception.frames": [{ file: "/var/www/releases/2026-10-06/billing/charge.ts:41:9", function: "charge" }],
      version: "v0.9",
    };
    const stamped = withFingerprint("error", "failed", liftException(original));
    expect(stamped?.["exception.frames"]).toEqual(original["exception.frames"]);
    expect(stamped?.version).toBe("v0.9");
    expect(original).not.toHaveProperty("e1");
    expect(stamped?.e1).toBe(computeFingerprint("error", "failed", {
      "exception.type": "TypeError",
      "exception.frames": [{ file: "billing/charge.ts", function: "charge" }],
    }));
  });

  test("numeric release-directory stamps and file URLs share the source-file fingerprint", () => {
    const hash = (file: string) => computeFingerprint("error", "failed", {
      "exception.type": "TypeError",
      "exception.frames": [{ file, function: "charge" }],
    });
    expect(hash("/var/www/releases/20261005123456/billing/charge.ts"))
      .toBe(hash("file:///var/www/releases/20261006123456/billing/charge.ts"));
    expect(hash("/var/www/releases/20261006123456/billing/charge.ts"))
      .toBe(hash("billing/charge.ts"));
  });

  test("source file, function and exception type differences remain distinct after path normalization", () => {
    const hash = (file: string, fn = "charge", type = "TypeError") => computeFingerprint("error", "failed", {
      "exception.type": type,
      "exception.frames": [{ file, function: fn }],
    });
    const base = hash("/app/billing/charge.ts");
    expect(hash("/app/billing/cancel.ts")).not.toBe(base);
    expect(hash("/app/billing/charge.ts", "cancel")).not.toBe(base);
    expect(hash("/app/billing/charge.ts", "charge", "RangeError")).not.toBe(base);
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
