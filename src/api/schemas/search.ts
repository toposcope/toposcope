import * as v from "valibot";
import { limit, optionalChoice, optionalText, q, repeated, requiredText, window } from "./common";

const omit = optionalText("0 or false counts each facet over the whole query; by default a facet leaves its own field out of it.");

export const searchQuery = v.object({
  ...window,
  q,
  cursor: optionalText("The cursor of the last page, for the next page of events."),
  since: optionalText("The newest event's time the caller has: only newer rows and the current bar come back."),
  limit,
  split: optionalText("Split the histogram by level (the default), service, host or none."),
  step: optionalText("Pin the histogram's bar width: 1ms, 10ms, 100ms, 1s, 10s, 1m, 5m, 15m, 1h, 4h, 1d or 7d."),
  agg: optionalText("A series derived from the rows: rate, or p99, avg, min, max or sum of a numeric attribute (p99:duration_ms)."),
  metric: optionalText("An ingested metric to plot instead, a histogram's with its reading first (p99:http.server.request.duration)."),
  ml: optionalText("The metric's label matchers, key:value separated by spaces, at most 4."),
  msplit: optionalText("A metric label key to split the metric's series by."),
  events: optionalText("0 skips the page of events."),
  keep: repeated("Series keys to keep in a split, besides other."),
  exact: optionalText("1 reads the stored rows rather than the rollups."),
  other: optionalText("1 folds the series past the cap into other."),
});

export const marksQuery = v.object({
  ...window,
  kind: optionalChoice(["deploy", "flag", "incident", "note"], "kind must be deploy, flag, incident, or note", "Only marks of this kind; any case.", true),
  service: optionalText("Only marks for this service."),
});

export const probesQuery = v.object({
  ...window,
  service: optionalText("Only probes of this service."),
});

export const profilesQuery = v.object({
  trace_id: requiredText("The trace, 32 hex characters.", "trace_id must be 32-character hex and span_id 16-character hex"),
  span_id: requiredText("The span, 16 hex characters.", "trace_id must be 32-character hex and span_id 16-character hex"),
});

export const contextQuery = v.object({
  ts: requiredText("The row's time, an ISO time.", "ts and service are required"),
  service: requiredText("The row's service.", "ts and service are required"),
  host: optionalText("The row's host."),
  n: optionalText("How many rows either side, a whole number."),
  q,
});

export const aroundQuery = v.object({
  ts: requiredText("The time to read either side of, an ISO time.", "ts is required"),
  from: window.from,
  to: window.to,
  n: optionalText("How many rows either side, a whole number."),
  q,
});

export const cutQuery = v.object({
  mark: requiredText("The change mark's id.", "mark is required"),
  ...window,
  q,
  opened: optionalText("The fingerprint whose row is open, kept in the answer."),
  live: optionalText("1 or true: the after side ends now."),
});

export const revisionsQuery = v.object({
  q,
  from: requiredText("Where the before side starts, an ISO time.", "from, after and to are required"),
  after: requiredText("The point between before and after, an ISO time.", "from, after and to are required"),
  to: requiredText("Where the after side ends, an ISO time.", "from, after and to are required"),
});

export const followSpanQuery = v.object({
  q: requiredText("The key:value to follow.", "q and at are required"),
  at: requiredText("The time to read a day either side of, an ISO time.", "q and at are required"),
});

export const fingerprintSeenQuery = v.object({
  from: optionalText("Where the window starts, an ISO time; the last 7 days by default."),
  to: optionalText("Where the window ends, an ISO time; now by default."),
});

const fields = optionalText("toposcope adds the instance each row entered at as a facet.");

export const facetsQuery = v.object({ ...window, q, limit, omit, fields });

export const attrKeysQuery = v.object({ ...window, q });

export const attrFacetsQuery = v.object({
  ...window,
  q,
  attrs: optionalText("The attribute keys to count, separated by commas."),
  limit,
  omit,
});

export const attrValuesQuery = v.object({
  ...window,
  q,
  key: optionalText("The attribute key."),
  prefix: optionalText("What the values start with."),
});

export const numericKeysQuery = v.object({ ...window, q });

export const metricNamesQuery = v.object({
  ...window,
  find: optionalText("Only names that contain this."),
  picked: optionalText("Names to list whatever the cap, separated by commas."),
});

export const metricLabelsQuery = v.object({
  ...window,
  name: requiredText("The metric's name.", "name is required"),
});

export const compareQuery = v.object({
  mark: requiredText("The change mark's id.", "mark is required"),
  ...window,
  q,
  agg: optionalText("Compare a series derived from the rows: rate, or p99, avg, min, max or sum of a numeric attribute (p99:duration_ms)."),
  metric: optionalText("Compare an ingested metric instead, a histogram's with its reading first (p99:http.server.request.duration)."),
  ml: optionalText("The metric's label matchers, key:value separated by spaces, at most 4."),
});

export const metricSeriesQuery = v.object({
  ...window,
  name: requiredText("The metric's name, a histogram's with its reading first (p99:http.server.request.duration).", "name is required"),
  ml: optionalText("Label matchers, key:value separated by spaces, at most 4."),
  msplit: optionalText("A label key to split the series by: one line per value, the 8 with the most points and other."),
  step: optionalText("Pin the bar width: 1ms, 10ms, 100ms, 1s, 10s, 1m, 5m, 15m, 1h, 4h, 1d or 7d."),
});
