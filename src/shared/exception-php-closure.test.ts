import { describe, expect, test } from "bun:test";
import { liftException } from "./exception";
import { computeFingerprint } from "./fingerprint";

/**
 * PHP 8.4 and later name a closure frame with the file and line it was
 * declared on. These lines are from a Slim 4.15.3 stack printed by PHP 8.5.11.
 */
function e1(root: string, closureLine = 15): string | undefined {
  const attrs = liftException({
    "exception.type": "DomainException",
    "exception.stacktrace": [
      `DomainException: order has no card in ${root}/src/Billing.php:12`,
      "Stack trace:",
      `#0 ${root}/public/index.php(16): Billing\\Billing->charge(Array)`,
      `#1 ${root}/vendor/slim/slim/Slim/Handlers/Strategies/RequestResponse.php(39): {closure:${root}/public/index.php:${closureLine}}(Object(Slim\\Psr7\\Request), Object(Slim\\Psr7\\Response), Array)`,
      `#2 ${root}/vendor/slim/slim/Slim/Routing/Route.php(362): Slim\\Handlers\\Strategies\\RequestResponse->__invoke(Object(Closure), Object(Slim\\Psr7\\Request), Object(Slim\\Psr7\\Response), Array)`,
      "#3 {main}",
    ].join("\n"),
  });
  return computeFingerprint("error", "order has no card", attrs);
}

describe("PHP closure frame named with its file", () => {
  test("one error keeps one e1 across deploy directories", () => {
    expect(e1("/usr/src/app")).toBe(e1("/app")!);
  });

  test("the id does not move when the closure's line number changes", () => {
    expect(e1("/app", 17)).toBe(e1("/app")!);
  });
});
