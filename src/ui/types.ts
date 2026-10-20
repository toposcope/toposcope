import type { MonitorSource, RemindId } from "../shared/monitor";
import type { HistogramReading } from "../shared/metric";
import type { WidgetLayout } from "../shared/widgets";
import type { BoardSlots } from "../shared/boards";

export type SavedSearch = {
  id: string;
  name: string;
  query: string;
  from_ts: string | null;
  to_ts: string | null;
  range: string | null;
  agg?: string | null;
  widgets?: WidgetLayout | null;
  board?: BoardSlots | null;
  cols?: string[];
  created_at: number;
};

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export type LevelCounts = Partial<Record<LogLevel, number>>;

export type LogEvent = {
  ts: string;
  service: string;
  host?: string;
  level: LogLevel;
  message: string;
  attrs?: Record<string, unknown>;
  /** Arrival sequence (#133); absent on rows stored before it. */
  seq?: number;
  /** Which instance the row entered at (#134); absent while unnamed. */
  toposcope?: string;
};

export type HistogramBucket = {
  t: string;
  n: number;
  series: Record<string, number>;
  by_level: LevelCounts;
};

export type SearchScan = {
  source: "refused";
  reason: string;
  histogram: boolean;
  events: boolean;
};

export type SearchResult = {
  events: LogEvent[];
  histogram: HistogramBucket[];
  total: number;
  nextCursor: string | null;
  from: string | null;
  to: string | null;
  ingested?: boolean;
  agg?: SearchAggResult;
  scan?: SearchScan;
};

export type AggBucket = { t: string; v: number };

export type SearchAggResult = {
  expr: string;
  source: "numeric" | "rate" | "refused" | "metric";
  reason?: string;
  buckets: AggBucket[];
  stat: number | null;
  /** For an ingested metric: a counter's bar is a sum, a gauge's an average. */
  kind?: "gauge" | "counter" | "histogram";
  /** For a histogram: which reading the bars are, and the histogram's own name. */
  reading?: HistogramReading;
  metric?: string;
  /** The unit the app sent the metric with, as sent (#104). */
  unit?: string;
  /** A metric split by one label: the label, and one line per value (8 and `other`). */
  split?: string;
  splits?: Array<{ key: string; buckets: AggBucket[]; stat: number | null }>;
};

export type FacetValue = { v: string; n: number };

export type FacetField = "level" | "service" | "host";

/** `toposcope` comes only when asked for (`fields=toposcope`): Search asks when something is linked (#139). */
export type Facets = Record<FacetField, FacetValue[]> & { toposcope?: FacetValue[] };

export type AlertKind = "threshold" | "first_seen";

/** The mark a first-seen alert last paged on. */
export type AlertLastMark = {
  id: string;
  kind: string;
  title: string;
  service: string;
  ts: string;
  count: number;
  at: number;
};

export type AlertRule = {
  id: string;
  name: string;
  kind: AlertKind;
  last_mark: AlertLastMark | null;
  body_kind: "default" | "text" | "json";
  body_template: string | null;
  saved_search_id: string | null;
  threshold: number;
  webhook_url: string | null;
  last_fired_at: number | null;
  last_attempt_at: number | null;
  last_status: string | null;
  last_error: string | null;
  consecutive_failures: number;
  silenced_until: number | null;
  /** As a monitor (#175). The server always sends these; fixtures may leave them out. */
  enabled?: number;
  source?: MonitorSource;
  state?: "ok" | "open";
  remind_every?: RemindId;
  resolved_body?: string | null;
  last_result?: "ok" | "warn" | "fail" | null;
  last_value?: number | null;
  last_result_at?: number | null;
};

/** A call sent for a stretch, or a new-fingerprints call (`sent`). */
export type MonitorCall = {
  id: number;
  monitor_id: string;
  stretch_id: string | null;
  at: number;
  what: "open" | "reminder" | "resolved" | "sent";
  status: string;
  ok: boolean;
  error: string | null;
};

/** One open-to-resolved stretch of a monitor, with its calls. */
export type MonitorStretch = {
  id: string;
  monitor_id: string;
  opened_at: number;
  resolved_at: number | null;
  closed_by: "ok" | "edit" | null;
  open_value: number | null;
  open_message: string;
  last_value: number | null;
  last_at: number;
  called_at: number | null;
  open_call: "sent" | "failed" | "silenced" | "none" | null;
  resolved_call: "sent" | "failed" | "silenced" | "none" | null;
  calls: MonitorCall[];
};

/** A monitor as `GET /api/monitors` lists it. */
export type MonitorView = AlertRule & {
  saved: { id: string; name: string; query: string; range: string | null; agg: string | null } | null;
  open: MonitorStretch | null;
};

export type MonitorsResponse = {
  now: number;
  from: string;
  to: string;
  monitors: MonitorView[];
  stretches: MonitorStretch[];
  sent: MonitorCall[];
  link: boolean;
};
