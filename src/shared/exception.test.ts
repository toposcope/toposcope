import { describe, expect, test } from "bun:test";
import { flattenAttrs } from "./attrs";
import { liftException, parseExceptionFrames } from "./exception";

describe("liftException", () => {
  test("keeps dotted OTEL keys and normalizes frames", () => {
    const lifted = liftException({
      "exception.type": "RuntimeError",
      "exception.frames": [
        { file: "app.ts", function: "run", in_app: true, line: 12 },
        { filename: "lib.ts", fn: "call" },
      ],
    });
    expect(lifted?.["exception.type"]).toBe("RuntimeError");
    expect(lifted?.["exception.frames"]).toEqual([
      { file: "app.ts", function: "run", in_app: true },
      { file: "lib.ts", function: "call" },
    ]);
  });

  test("lifts a nested exception object without parsing stacktrace", () => {
    const lifted = liftException({
      exception: {
        type: "Error",
        message: "boom",
        stacktrace: "Error: boom\n    at run (app.ts:1:1)",
        frames: [{ file: "app.ts", function: "run", in_app: true }],
      },
    });
    expect(lifted?.["exception.type"]).toBe("Error");
    expect(lifted?.["exception.message"]).toBe("boom");
    expect(lifted?.["exception.stacktrace"]).toContain("at run");
    expect(lifted?.exception).toBeUndefined();
    expect(lifted?.["exception.frames"]).toEqual([
      { file: "app.ts", function: "run", in_app: true },
    ]);
  });

  test("does not invent fields from a PHP fatal message", () => {
    expect(
      liftException({
        path: "/index.php",
      }),
    ).toEqual({ path: "/index.php" });
    expect(liftException(undefined)).toBeUndefined();
  });

  test("flattenAttrs stores type and frames as search keys", () => {
    const flat = flattenAttrs(
      liftException({
        exception: {
          type: "Error",
          frames: [{ file: "a.php", function: "foo", in_app: true }],
        },
      }),
    );
    expect(flat["exception.type"]).toBe("Error");
    expect(JSON.parse(flat["exception.frames"] ?? "[]")).toEqual([
      { file: "a.php", function: "foo", in_app: true },
    ]);
  });

  test.each([
    {
      format: "Node/V8",
      stacktrace: "TypeError: payment failed\n    at charge (/app/src/billing.ts:41:9)\n    at processPayment (/app/src/api.ts:88:5)",
      frames: [
        { file: "/app/src/billing.ts", function: "charge" },
        { file: "/app/src/api.ts", function: "processPayment" },
      ],
    },
    {
      format: "Python",
      stacktrace: "Traceback (most recent call last):\n  File \"/app/src/api.py\", line 88, in process_payment\n    charge()\n  File \"/app/src/billing.py\", line 41, in charge\n    raise ValueError(\"payment failed\")\nValueError: payment failed",
      frames: [
        { file: "/app/src/api.py", function: "process_payment" },
        { file: "/app/src/billing.py", function: "charge" },
      ],
    },
    {
      format: "JVM",
      stacktrace: "java.lang.IllegalStateException: payment failed\n\tat com.example.Billing.charge(Billing.java:41)\n\tat com.example.Api.processPayment(Api.java:88)",
      frames: [
        { file: "Billing.java", function: "com.example.Billing.charge" },
        { file: "Api.java", function: "com.example.Api.processPayment" },
      ],
    },
    {
      format: ".NET",
      stacktrace: "System.InvalidOperationException: payment failed\n   at Billing.Charge() in /app/src/Billing.cs:line 41\n   at Api.ProcessPayment() in /app/src/Api.cs:line 88",
      frames: [
        { file: "/app/src/Billing.cs", function: "Billing.Charge()" },
        { file: "/app/src/Api.cs", function: "Api.ProcessPayment()" },
      ],
    },
    {
      format: "PHP",
      stacktrace: "#0 /app/src/billing.php(41): charge()\n#1 /app/src/api.php(88): processPayment()\n#2 {main}",
      frames: [
        { file: "/app/src/billing.php", function: "charge" },
        { file: "/app/src/api.php", function: "processPayment" },
      ],
    },
    {
      format: "Go",
      stacktrace: "goroutine 1 [running]:\nmain.charge(...)\n\t/app/src/billing.go:41 +0x48\nmain.processPayment()\n\t/app/src/api.go:88 +0x15",
      frames: [
        { file: "/app/src/billing.go", function: "main.charge" },
        { file: "/app/src/api.go", function: "main.processPayment" },
      ],
    },
  ])("parses $format exception.stacktrace without sender-supplied frames", ({ stacktrace, frames }) => {
    const lifted = liftException({
      "exception.type": "Error",
      "exception.stacktrace": stacktrace,
    });
    expect(lifted?.["exception.frames"]).toEqual(frames);
  });

  test("nested exception.stacktrace supplies frames when the sender has no frame array", () => {
    const lifted = liftException({
      exception: {
        type: "TypeError",
        stacktrace: "TypeError: failed\n    at charge (/app/billing.ts:41:9)",
      },
    });
    expect(lifted?.["exception.frames"]).toEqual([
      { file: "/app/billing.ts", function: "charge" },
    ]);
  });
});

describe("parseExceptionFrames", () => {
  test("parses a JSON string and caps at 50", () => {
    expect(parseExceptionFrames('[{"file":"a.ts","function":"run"}]')).toEqual([
      { file: "a.ts", function: "run" },
    ]);
    const many = Array.from({ length: 60 }, (_, i) => ({
      file: `f${i}.ts`,
      function: "x",
    }));
    expect(parseExceptionFrames(many)).toHaveLength(50);
    expect(parseExceptionFrames("not json")).toEqual([]);
  });
});
