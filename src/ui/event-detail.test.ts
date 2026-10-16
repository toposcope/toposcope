import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EventDetail } from "./components/event-detail";
import type { LogEvent } from "./types";

// The message of #105. At 1440×900 the detail panel shows it in four lines,
// and the third is drawn on the `e1` value.
const longMessage =
  "webhook wh_8f2c did not take sandbox.stopped on its last try, 8, and it is not sent again";

const stack = [
  "Error: No answer within 2 seconds.",
  "    at deliver (/app/dist/webhooks/deliver.js:41:13)",
  "    at async retryPass (/app/dist/webhooks/retry.js:88:7)",
  "    at async Timeout._onTimeout (/app/dist/scheduler.js:23:5)",
].join("\n");

const event: LogEvent = {
  ts: "2026-10-16T09:41:07.312Z",
  service: "api",
  host: "control-1",
  level: "error",
  message: longMessage,
  attrs: {
    e1: "e1:5c0f3a9b2d71",
    "exception.type": "Error",
    "exception.stacktrace": stack,
  },
};

function detailHtml(): string {
  return renderToStaticMarkup(
    createElement(EventDetail, {
      event,
      onClose: () => {},
      onFilter: () => {},
      onAround: () => {},
      fromMs: Date.parse("2026-10-16T09:00:00.000Z"),
      spanMs: 60 * 60 * 1000,
    }),
  );
}

/** The class of the Fields row whose key is `key`. */
function rowClass(html: string, key: string): string {
  const rows = [...html.matchAll(/<div class="([^"]*)"><dt[^>]*>([^<]*)<\/dt>/g)];
  const row = rows.find((match) => match[2] === key);
  if (!row) {
    throw new Error(`no Fields row for ${key}; rows: ${rows.map((match) => match[2]).join(", ")}`);
  }
  return row[1]!;
}

/** A Tailwind class that pins the row's height (`h-7`, `h-[28px]`), not a floor. */
const fixedHeight = /(?:^|\s)h-(?:\d|\[)/;

// Every Fields row was `h-7`: 28px whatever its value. A value that wraps is
// drawn past the bottom of its row and over the next one, and the next row is
// drawn where it would be if the value were one line. A message of three lines
// or more draws its third line on the `e1` row below it.
describe("an event's Fields rows", () => {
  test("a message that wraps makes its row taller, not drawn over the e1 row", () => {
    const html = detailHtml();
    expect(html).toContain(longMessage);
    expect(rowClass(html, "message")).not.toMatch(fixedHeight);
  });

  test("an attribute that wraps, such as a stack trace, makes its row taller too", () => {
    const html = detailHtml();
    expect(rowClass(html, "exception.stacktrace")).not.toMatch(fixedHeight);
  });
});
