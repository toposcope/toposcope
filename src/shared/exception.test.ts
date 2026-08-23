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
