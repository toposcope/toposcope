import * as v from "valibot";

/**
 * Pieces the route schemas share (#356). A query value is text: a schema says what the text
 * means, and the handler still reads it as it did. A required key carries the handler's own
 * words for a missing one.
 */
export function text(description: string) {
  return v.pipe(v.string(), v.description(description));
}

export function optionalText(description: string) {
  return v.optional(text(description));
}

/** A key the handler cannot do without: its words when it is left out. */
export function requiredText(description: string, missing: string) {
  return v.pipe(v.string(missing), v.description(description));
}

/** A key that may repeat: `keep=a&keep=b`. */
export function repeated(description: string) {
  return v.optional(v.pipe(v.array(v.string()), v.description(description)));
}

/**
 * A key that takes one of a few words. Left empty it is absent, as the handlers read it; with
 * `fold`, case and spaces around it do not matter either.
 */
export function optionalChoice(options: readonly [string, ...string[]], message: string, description: string, fold = false) {
  const word = fold ? v.pipe(v.string(message), v.trim(), v.toLowerCase(), v.picklist(options, message)) : v.picklist(options, message);
  return v.optional(v.pipe(v.union([v.literal(""), word], message), v.description(description)));
}

export const q = optionalText("A query in Toposcope's query language (docs/query.md); empty matches every row.");

/** The window most reads take: `range`, or `from` and `to`. */
export const window = {
  from: optionalText("Where the window starts, an ISO time."),
  to: optionalText("Where the window ends, an ISO time."),
  range: optionalText("A window that ends now, as 15m, 1h, 24h, 7d or any \\d+(ms|s|m|h|d|w) up to 365d; it wins over from and to."),
};

export const limit = optionalText("How many to return at most, a whole number.");
