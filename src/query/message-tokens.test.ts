import { describe, expect, test } from "bun:test";
import { messageMatchesText, messageTokens } from "./message-tokens";

describe("messageTokens", () => {
  test("splits on non-alphanumeric ASCII after lowercasing", () => {
    expect(messageTokens("Timeout")).toEqual(["timeout"]);
    expect(messageTokens("foo-bar:x")).toEqual(["foo", "bar", "x"]);
    expect(messageTokens("connection reset")).toEqual(["connection", "reset"]);
    expect(messageTokens("!!!")).toEqual([]);
  });
});

describe("messageMatchesText", () => {
  test("one token is a word, not a substring", () => {
    expect(messageMatchesText("connection timeout", "TIMEOUT")).toBe(true);
    expect(messageMatchesText("connection timeouts", "timeout")).toBe(false);
    expect(messageMatchesText("context deadline exceeded", "dead")).toBe(false);
    expect(messageMatchesText("context deadline exceeded", "DEADLINE")).toBe(
      true,
    );
  });

  test("several tokens must be consecutive", () => {
    expect(messageMatchesText("context deadline exceeded", "deadline exceeded")).toBe(
      true,
    );
    expect(messageMatchesText("deadline was exceeded", "deadline exceeded")).toBe(
      false,
    );
    expect(messageMatchesText("e2e-1786898064153", "e2e-1786898064153")).toBe(
      true,
    );
  });
});
