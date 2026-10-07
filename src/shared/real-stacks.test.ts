import { describe, expect, test } from "bun:test";
import { liftException, type ExceptionFrame } from "./exception";
import { computeFingerprint } from "./fingerprint";

const fixtures = `${import.meta.dir}/../../fixtures/ingest`;
const guide = await Bun.file(`${import.meta.dir}/../../docs/ingest.md`).text();
const versions = (await Bun.file(`${fixtures}/versions.json`).json()) as {
  stacks: Record<
    string,
    { runtime: string; framework: string; type: string; raise: string }
  >;
};

/** Where each program ran. Both are roots the hash strips. */
const checkouts = ["app", "usr-src-app"] as const;

/** Findings from real output. Each is a named bug in the bug loop; unpin when it is fixed. */
const pinned: Record<string, string> = {
  php: "a PHP closure frame carries the checkout path in its function name",
};

async function captured(runtime: string, checkout: (typeof checkouts)[number]) {
  const stacktrace = await Bun.file(`${fixtures}/stacks/${runtime}.${checkout}.txt`).text();
  const attrs = liftException({
    "exception.type": versions.stacks[runtime]!.type,
    "exception.stacktrace": stacktrace,
  });
  return {
    frames: (attrs?.["exception.frames"] ?? []) as ExceptionFrame[],
    e1: (message: string) => computeFingerprint("error", message, attrs),
  };
}

describe("stacks real runtimes print", () => {
  test("one for each format ingest reads", () => {
    expect(Object.keys(versions.stacks).sort()).toEqual([
      "dotnet",
      "go",
      "jvm",
      "node",
      "php",
      "python",
    ]);
  });

  for (const [runtime, source] of Object.entries(versions.stacks)) {
    describe(`${runtime}: ${source.runtime} with ${source.framework}`, () => {
      test("frames are read, down to the function that raised", async () => {
        const { frames } = await captured(runtime, "app");
        expect(frames.length).toBeGreaterThan(1);
        expect(frames.map((frame) => frame.function)).toContain(source.raise);
      });

      test("e1 comes from the frames, not the message", async () => {
        const { e1 } = await captured(runtime, "app");
        expect(e1("order has no card")).toMatch(/^[0-9a-f]{16}$/);
        expect(e1("a reworded message")).toBe(e1("order has no card")!);
      });

      const oneIdAcrossCheckouts = async () => {
        const [first, second] = await Promise.all(
          checkouts.map((checkout) => captured(runtime, checkout)),
        );
        expect(second!.e1("order has no card")).toBe(first!.e1("order has no card")!);
      };
      const bug = pinned[runtime];
      if (bug) {
        test.failing(`a second checkout directory gets the same e1 (bug: ${bug})`, oneIdAcrossCheckouts);
      } else {
        test("a second checkout directory gets the same e1", oneIdAcrossCheckouts);
      }

      test("the ingest guide names the versions it came from", () => {
        expect(guide).toContain(source.runtime);
        expect(guide).toContain(source.framework);
      });
    });
  }
});
