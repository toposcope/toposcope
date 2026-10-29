import * as v from "valibot";

const keys = (description: string) =>
  v.nullish(v.pipe(v.union([v.string(), v.array(v.string())]), v.description(description)));

const panel = v.object({
  name: v.pipe(v.string(), v.description("The panel's name, as a page's data-panel= names it: lower-case letters, digits, . _ -, up to 48.")),
  params: v.pipe(
    v.record(v.string(), v.union([v.string(), v.number()])),
    v.description("The embed tag's params: chart (line, bars, stacked, stat, top or donut; line by default), metric, reading, ml, split, agg, key (a top or donut panel needs one), n, range, step, title."),
  ),
  from: v.nullish(v.pipe(v.string(), v.description("Where the panel was made, kept as a note."))),
});

const scope = v.pipe(
  v.object({
    metric_names: keys("Metric names the share may read, exact or a prefix glob (fleet_*), as a list or separated by commas; at most 50."),
    metric_labels: v.nullish(v.pipe(v.string(), v.description("Label matchers ANDed onto every metric read, key:value as ml= takes them."))),
    logs: v.nullish(v.pipe(v.string(), v.description("A q ANDed onto every log read; null or empty: the share reads no logs."))),
    split: keys("Keys a read may split or Top-N by, at most 8."),
    narrow: keys("Keys a caller may narrow by as key:value, at most 8."),
  }),
  v.description("What the share can ever read; left out, it is derived from the panels. It must cover them."),
);

const limits = v.nullish(
  v.pipe(
    v.object({
      min_step: v.optional(v.pipe(v.string(), v.description("The finest bar a read gets, 1ms … 7d as step= takes it; 1m by default."))),
      max_range: v.optional(v.pipe(v.string(), v.description("The longest window one read covers, up to 365d (30d, 12h, 2w); 7d by default."))),
      max_lookback: v.optional(v.pipe(v.string(), v.description("How far before now a window may start, up to 730d; 30d by default."))),
      reads_per_minute: v.optional(
        v.pipe(
          v.number("limits.reads_per_minute is a whole number, 1–6000"),
          v.integer("limits.reads_per_minute is a whole number, 1–6000"),
          v.minValue(1, "limits.reads_per_minute is a whole number, 1–6000"),
          v.maxValue(6000, "limits.reads_per_minute is a whole number, 1–6000"),
          v.description("Reads a minute; 120 by default."),
        ),
      ),
    }),
    v.description("How fine, how long and how often a read may be; a field left out keeps its value, or takes its default."),
  ),
);

const embed = v.nullish(
  v.pipe(
    v.object({
      frame_ancestors: keys("Origins that may frame the share's panels (https://host[:port], no paths, no *), at most 8; empty: JSON only."),
      ticket_ttl: v.optional(v.pipe(v.string(), v.description("How long a ticket lasts, up to 24h (15m, 1h); 1h by default."))),
    }),
    v.description("Embedding the share's panels in a page; a field left out keeps its value, or takes its default."),
  ),
);

const share = {
  panels: v.nullish(v.pipe(v.array(panel), v.description("Named panels, at most 24; the fence is derived from them. Left out, a share keeps its panels."))),
  logs: v.nullish(v.pipe(v.string(), v.description("With panels and no scope: the q ANDed onto every log read."))),
  scope: v.optional(scope),
  raw_params: v.optional(v.pipe(v.boolean("raw_params is true or false"), v.description("Whether a page may pass its own params within the fence; on by default."))),
  expires_at: v.optional(
    v.pipe(
      v.union([v.string(), v.number()]),
      v.description("When the share stops: a date (2027-10-23), an ISO time or epoch ms, after now and at most a year out. An Owner must give it."),
    ),
  ),
  limits,
  embed,
};

export const shareCreateBody = v.object({
  name: v.pipe(v.string("name: lower-case letters, digits, . _ -, up to 64"), v.description("The share's name, in its URL and its use rows: lower-case letters, digits, . _ -, up to 64.")),
  ...share,
});

export const sharePutBody = v.object(share);
