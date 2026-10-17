import { describe, expect, test } from "bun:test";
import {
  alertBodyProblem,
  checkJsonBody,
  fillAlertBody,
  jsonBodyFaultText,
  unknownFillIns,
} from "./alert-body";

// Frame 15i's Pushover body, and 15g's with the comma left out.
const pushover = '{\n  "token": "[YOUR APP TOKEN]",\n  "user": "[YOUR USER KEY]",\n  "title": "{{alert.name}}",\n  "message": "{{fingerprints.count}} new after {{mark.kind}} {{mark.version}}: {{fingerprints.first}}",\n  "url": "{{link}}"\n}';
const broken = '{\n  "token": "[YOUR APP TOKEN]",\n  "user": "[YOUR USER KEY]"\n  "message": "{{fingerprints.count}} new after {{mark.kind}} {{mark.version}}",\n  "url": "{{link}}"\n}';

describe("an alert's body of its own (#108)", () => {
  test("a JSON body escapes each fill-in as JSON: quotes and backslashes in q", () => {
    const q = 'message:"a \\"quoted\\" path" path:C:\\temp';
    const body = fillAlertBody('{"q": "{{query}}", "name": "{{alert.name}}"}', { query: q, "alert.name": "new bugs" }, "json");
    expect(JSON.parse(body)).toEqual({ q, name: "new bugs" });
  });

  test("a text body is the text, filled in as is", () => {
    expect(fillAlertBody("{{alert.name}}: {{ value }}\n{{link}}", { "alert.name": "api p99 slow", value: "912" }, "text")).toBe("api p99 slow: 912\n");
  });

  test("a JSON body that parses, with fill-ins as strings", () => {
    expect(checkJsonBody(pushover)).toBeNull();
    expect(checkJsonBody('{"n": {{value}}}')).not.toBeNull();
  });

  test("a JSON body that does not parse says where, the way 15g does", () => {
    const f = checkJsonBody(broken)!;
    expect(f).toEqual({ line: 4, column: 3, what: "a , is missing", after: '"[YOUR USER KEY]"' });
    expect(jsonBodyFaultText(f)).toBe('Not JSON yet: line 4, column 3 — a , is missing after "[YOUR USER KEY]".');
    expect(checkJsonBody('{"a": "b')?.what).toBe('a " is missing to close this string');
    expect(checkJsonBody('{"a" "b"}')?.what).toBe("a : is missing");
    expect(checkJsonBody('{"a": 1} x')?.what).toBe("there is more after the body's end");
  });

  test("a fill-in the alert does not have is refused by name", () => {
    expect(unknownFillIns("{{alert.name}} {{fingerprints}}", "threshold")).toEqual(["fingerprints"]);
    expect(unknownFillIns("{{alert.name}} {{fingerprints}}", "first_seen")).toEqual([]);
    expect(alertBodyProblem("text", "{{nope}}", "threshold")).toBe("{{nope}} is not a fill-in for this alert");
    expect(alertBodyProblem("json", broken, "first_seen")).toBe(
      'Not JSON yet: line 4, column 3 — a , is missing after "[YOUR USER KEY]". Fill-ins count as strings here, so check the quotes around them.',
    );
    expect(alertBodyProblem("json", pushover, "first_seen")).toBeNull();
    expect(alertBodyProblem("default", "", "threshold")).toBeNull();
    expect(alertBodyProblem("text", "  ", "threshold")).toBe("the body is empty");
  });
});
