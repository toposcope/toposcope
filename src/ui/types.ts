import type { CantTell, MonitorSource, OpensWhen, RemindId } from "../shared/monitor";
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
  /** Home's Pinned column (#259). */
  pinned?: boolean;
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
  /** A histogram read as a heatmap (#238): bounds rising, and per bar one count per bound. */
  heat?: { le: number[]; cells: Array<{ t: string; n: number[] }> };
};

export type FacetValue = { v: string; n: number };

export type FacetField = "level" | "service" | "host";

/** `toposcope` comes only when asked for (`fields=toposcope`): Search asks when something is linked (#139). */
export type Facets = Record<FacetField, FacetValue[]> & { toposcope?: FacetValue[]; e1?: FacetValue[] };

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
  /** #279: its series, or its search's share of all rows in percent. */
  measure?: "series" | "share";
  webhook_url: string | null;
  /** #280: every delivery target, URLs or `default`. */
  webhook_urls?: string[] | null;
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
  /** A search monitor opens at least or fewer than its threshold (#176). */
  opens_when?: OpensWhen;
  /** The service it is about and the host it checks (#335); empty on monitors made before. */
  service?: string;
  host?: string;
  /** Why a fewer-than monitor stayed shut on its last pass. */
  cant_tell?: CantTell | null;
  /** A push monitor (#177): its schedule, the time its next result counts from, a run in flight, its last ok. */
  query?: string;
  every_ms?: number | null;
  grace_ms?: number | null;
  due_from?: number | null;
  started_at?: number | null;
  last_ok_at?: number | null;
  paused_at?: number | null;
  created_at?: number;
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
  /** A push monitor opened by a result that never came: when it was due (#177). */
  due_at?: number | null;
  calls: MonitorCall[];
};

/** A result, as a lane draws it (#177): the worst of its column of the clock. */
export type PushResultRow = {
  id: number;
  monitor_id: string;
  at: number;
  result: "ok" | "warn" | "fail";
  exit_code: number | null;
  duration_ms: number | null;
  value: number | null;
  unit: string | null;
  message: string;
  host: string;
  via: string;
};

/** An HTTP(S) monitor's last run (#178). */
export type HttpLastRun = {
  at: number;
  result: "ok" | "warn" | "fail";
  status: number | null;
  duration_ms: number;
  line: string | null;
  why: string | null;
  cert_valid_to: string | null;
};

/** What an HTTP(S) monitor calls: its headers by name only. */
export type HttpMonitorView = {
  url: string;
  method: "GET" | "HEAD" | "POST";
  body: string | null;
  headers: string[];
  every: string;
  every_ms: number;
  conditions: string;
  fail_after: number;
  fails_in_row: number;
  next_run_at: number | null;
  last_run: HttpLastRun | null;
};

/** A TCP or certificate monitor's last run (#180). */
export type NetLastRun = {
  at: number;
  result: "ok" | "warn" | "fail";
  connected: boolean;
  duration_ms: number;
  line: string | null;
  why: string | null;
  cert_valid_to: string | null;
  cert_subject: string | null;
};

/** Where a TCP or certificate monitor connects (#180). */
export type NetMonitorView = {
  target: string;
  starttls: "smtp" | "imap" | "pop3" | null;
  every: string;
  every_ms: number;
  conditions: string;
  fail_after: number;
  fails_in_row: number;
  next_run_at: number | null;
  last_run: NetLastRun | null;
};

/** A monitor as `GET /api/monitors` lists it. */
export type MonitorView = AlertRule & {
  /** The service it is about (#335): empty on a monitor made before, which asks to be edited. */
  service: string;
  /** The host it checks (#335): a URL's or address's host unless changed; may be empty. */
  host: string;
  /** Who made it (#307). */
  made_by?: { id: string; name: string; revoked: boolean; kind: string } | null;
  saved: { id: string; name: string; query: string; range: string | null; agg: string | null } | null;
  open: MonitorStretch | null;
  /** A fewer-than monitor's newest matching line; null when none in a year, absent when unread. */
  last_line_at?: number | null;
  /** Set on an HTTP(S) monitor. Fixtures may leave it out. */
  http?: HttpMonitorView | null;
  /** Set on a TCP or certificate monitor. Fixtures may leave it out. */
  net?: NetMonitorView | null;
};

/** `POST /api/monitors/send`: the editor's Send (18r). */
export type HttpSendResult = {
  at: number;
  url: string;
  method: "GET" | "HEAD" | "POST";
  response: {
    status: number;
    status_text: string;
    http_version: string;
    headers: Array<[string, string]>;
    body: string;
    body_bytes: number;
    truncated: boolean;
  } | null;
  error: string | null;
  timings: { dns: number; connect: number; tls: number | null; wait: number; body: number; total: number };
  cert: { subject: string; issuer: string; valid_to: string } | null;
  duration_ms: number;
};

/** `POST /api/monitors/send` with `source: "tcp" | "cert"`: the TCP · certificate editor's Send (#180). */
export type NetSendResult = {
  at: number;
  source: "tcp" | "cert";
  target: string;
  starttls: "smtp" | "imap" | "pop3" | null;
  connected: boolean;
  address: string | null;
  /** A mail server's greeting before STARTTLS. */
  greeting: string | null;
  /** `TLS 1.3`, on a certificate monitor that got that far. */
  protocol: string | null;
  error: string | null;
  timings: { dns: number; connect: number; starttls: number | null; tls: number | null; total: number };
  cert: { subject: string; names: string[]; issuer: string; valid_to: string; untrusted: string | null } | null;
  duration_ms: number;
};

export type MonitorsResponse = {
  now: number;
  from: string;
  to: string;
  monitors: MonitorView[];
  stretches: MonitorStretch[];
  sent: MonitorCall[];
  /** Results in the window, at most 240 columns a lane; older servers and fixtures leave them out. */
  results?: PushResultRow[];
  link: boolean;
};

/** A monitor's own page: a push monitor's key and last result come only here. */
export type MonitorPage = MonitorView & { ping_key?: string | null; last?: PushResultRow | null; stretches: MonitorStretch[] };
