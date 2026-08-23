type CounterName =
  | "ingest_events"
  | "ingest_metrics"
  | "ingest_marks"
  | "syslog_packets"
  | "otlp_events"
  | "otlp_spans"
  | "otlp_profile_samples"
  | "search_requests"
  | "alert_fires";

const counters: Record<CounterName, number> = {
  ingest_events: 0,
  ingest_metrics: 0,
  ingest_marks: 0,
  syslog_packets: 0,
  otlp_events: 0,
  otlp_spans: 0,
  otlp_profile_samples: 0,
  search_requests: 0,
  alert_fires: 0,
};

export function incMetric(name: CounterName, n = 1): void {
  counters[name] += n;
}

export function renderMetrics(): string {
  const lines = [
    "# HELP toposcope_ingest_events_total Log events written to ClickHouse",
    "# TYPE toposcope_ingest_events_total counter",
    `toposcope_ingest_events_total ${counters.ingest_events}`,
    "# HELP toposcope_ingest_metrics_total Metric points written to ClickHouse",
    "# TYPE toposcope_ingest_metrics_total counter",
    `toposcope_ingest_metrics_total ${counters.ingest_metrics}`,
    "# HELP toposcope_ingest_marks_total Change marks written to ClickHouse",
    "# TYPE toposcope_ingest_marks_total counter",
    `toposcope_ingest_marks_total ${counters.ingest_marks}`,
    "# HELP toposcope_syslog_packets_total Syslog UDP packets accepted",
    "# TYPE toposcope_syslog_packets_total counter",
    `toposcope_syslog_packets_total ${counters.syslog_packets}`,
    "# HELP toposcope_otlp_events_total Events mapped from OTLP JSON",
    "# TYPE toposcope_otlp_events_total counter",
    `toposcope_otlp_events_total ${counters.otlp_events}`,
    "# HELP toposcope_otlp_spans_total Spans mapped from OTLP traces",
    "# TYPE toposcope_otlp_spans_total counter",
    `toposcope_otlp_spans_total ${counters.otlp_spans}`,
    "# HELP toposcope_otlp_profile_samples_total Samples mapped from OTLP profiles",
    "# TYPE toposcope_otlp_profile_samples_total counter",
    `toposcope_otlp_profile_samples_total ${counters.otlp_profile_samples}`,
    "# HELP toposcope_search_requests_total Search API requests",
    "# TYPE toposcope_search_requests_total counter",
    `toposcope_search_requests_total ${counters.search_requests}`,
    "# HELP toposcope_alert_fires_total Alert webhooks posted",
    "# TYPE toposcope_alert_fires_total counter",
    `toposcope_alert_fires_total ${counters.alert_fires}`,
    "",
  ];
  return lines.join("\n");
}
