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
};

export type FacetValue = { v: string; n: number };

export type FacetField = "level" | "service" | "host";

export type Facets = Record<FacetField, FacetValue[]>;

export type AlertRule = {
  id: string;
  name: string;
  saved_search_id: string | null;
  threshold: number;
  webhook_url: string | null;
  last_fired_at: number | null;
  last_attempt_at: number | null;
  last_status: string | null;
  last_error: string | null;
  consecutive_failures: number;
  silenced_until: number | null;
};
