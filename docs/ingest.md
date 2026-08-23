# Ingest

Toposcope accepts logs, metrics, traces, and profiles over HTTP. The canonical path is Vector → `POST /v1/logs` with OTLP protobuf.

Use the same ingest token for `POST /v1/logs`, `POST /v1/metrics`, `POST /v1/traces`, and `POST /v1/profiles`. Toposcope does not ship a default ingest token.

## Create an ingest token

Create a named token from the HTTP API. The token value is shown once.

```bash
curl -u "toposcope:${TOPOSCOPE_PASSWORD}" -X POST http://127.0.0.1:8080/api/api-tokens \
  -H 'content-type: application/json' \
  -d '{"name":"vector"}'
```

## Limits and responses

HTTP ingest bodies are limited to 1 MB. A request may contain at most 500 log events, metric points, spans, or profiles, depending on the endpoint.

Successful requests return the number of ingested records. Invalid batches return a `4xx` response. When ClickHouse is overloaded or the application has no insert capacity, HTTP ingest returns `429` with `Retry-After: 1`; collectors should retry and buffer upstream.

## Logs

### Manual JSON / NDJSON

Use this path when you want to post events directly.

```bash
curl -u "toposcope:${TOPOSCOPE_PASSWORD}" -X POST http://127.0.0.1:8080/api/ingest \
  -H 'content-type: application/x-ndjson' \
  --data-binary '{"service":"api","level":"error","message":"timeout"}'
```

### OTLP JSON

Use OTLP JSON when your collector is configured for HTTP JSON export.

```bash
curl -X POST http://127.0.0.1:8080/v1/logs \
  -H "authorization: Bearer ${TOPOSCOPE_INGEST_TOKEN}" \
  -H 'content-type: application/json' \
  -d '{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"api"}}]},"scopeLogs":[{"logRecords":[{"severityText":"ERROR","body":{"stringValue":"timeout"}}]}]}]}'
```

For collectors, set `OTEL_EXPORTER_OTLP_PROTOCOL=http/json` and `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:8080`.

### OTLP protobuf

This is the default path for Vector, Fluent Bit, and Alloy.

```text
POST /v1/logs
Authorization: Bearer ${TOPOSCOPE_INGEST_TOKEN}
Content-Type: application/x-protobuf
```

Collectors send the protobuf body directly on that path.

## Metrics

Metrics use the same bearer token as logs. This is not Prometheus scrape; that stays `GET /api/metrics`.

```bash
curl -X POST http://127.0.0.1:8080/v1/metrics \
  -H "authorization: Bearer ${TOPOSCOPE_INGEST_TOKEN}" \
  -H 'content-type: application/json' \
  -d '{"name":"cpu_seconds","value":0.42,"labels":{"service":"api"}}'
```

## Traces

Toposcope stores the spans it receives. Sampling stays at the collector.

```bash
curl -X POST http://127.0.0.1:8080/v1/traces \
  -H "authorization: Bearer ${TOPOSCOPE_INGEST_TOKEN}" \
  -H 'content-type: application/json' \
  -d '{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"nginx"}}]},"scopeSpans":[{"spans":[{"traceId":"aabbccddeeff00112233445566778899","spanId":"1122334455667788","name":"GET /","startTimeUnixNano":"1692000000000000000","endTimeUnixNano":"1692000000412000000","status":{"code":1}}]}]}]}'
```

`Content-Type: application/x-protobuf` uses the same `POST /v1/traces` path.

## Profiles

Profiles use the same bearer token. Toposcope stores what arrives and joins only samples that carry both a `trace_id` and a `span_id` link.

```bash
curl -X POST http://127.0.0.1:8080/v1/profiles \
  -H "authorization: Bearer ${TOPOSCOPE_INGEST_TOKEN}" \
  -H 'content-type: application/x-protobuf' \
  --data-binary @profile.pb
```

Toposcope does not use `/debug/pprof` scraping.

## Vector

Vector is the canonical collector. The shipped `vector.yaml` uses OTLP HTTP protobuf and posts to `http://127.0.0.1:8080/v1/logs`.

```yaml
sinks:
  toposcope:
    type: opentelemetry
    inputs: [your_source]
    protocol:
      type: http
      uri: http://127.0.0.1:8080/v1/logs
      # traces sink: same block with uri …/v1/traces
      encoding:
        codec: otlp
      request:
        headers:
          Authorization: "Bearer ${TOPOSCOPE_INGEST_TOKEN}"
```

## Fluent Bit

```ini
[OUTPUT]
    Name                 opentelemetry
    Match                *
    Host                 127.0.0.1
    Port                 8080
    Logs_uri             /v1/logs
    Traces_uri           /v1/traces
    Header               Authorization Bearer ${TOPOSCOPE_INGEST_TOKEN}
```

## Alloy

Alloy’s `otelcol.exporter.otlphttp` posts traces to `{endpoint}/v1/traces` and profiles to `{endpoint}/v1/profiles` on the same client. OTLP HTTP uses protobuf by default; JSON still works.

```hcl
otelcol.auth.headers "toposcope" {
  header {
    key   = "Authorization"
    value = "Bearer ${TOPOSCOPE_INGEST_TOKEN}"
  }
}

otelcol.exporter.otlphttp "toposcope" {
  client {
    endpoint = "http://127.0.0.1:8080"
    auth     = otelcol.auth.headers.toposcope.handler
  }
}
```

## Enrich at the collector

`q`, Top-N, and rollups only see stored keys. If a field must be searchable or appear in Top-N, the collector must write it as a top-level string attr before ingest.

Supported collector-side operations:

| Operation | What it does |
| --- | --- |
| alias / copy | rename or duplicate a key |
| combine | turn N keys into one stored key |
| bucket | reduce cardinality so Top-N is not unique-per-event |
| local lookup | map a local file such as MMDB or CSV to one top-level key |

Match on `service` and/or required-key existence so every event does not run every rule. Nested objects become one JSON blob and are not dotted `q` paths. Extra keys count toward the 50-key cap. A detail-panel lookup does not satisfy `q` or Top-N.

Direct ingest without a collector does not grow collector-style derived keys (alias/combine/bucket/lookup). `exception.type` and `exception.frames` are ordinary attrs: store them when they arrive (app, OTEL, or collector enrich). Ingest does not parse them out of `message`. Ingest does write `e1` (16-hex SHA-256) when frames are present, or when `exception.type` is set or the level is `error`/`fatal`, so `e1:…` hunts the same bug. Existing rows are not rewritten.

### Worked example

Before enrichment:

```json
{"service":"api","level":"info","message":"ok","attrs":{"lat":51.5074,"lng":-0.1278,"client_ip":"8.8.8.8","user_id":"42"}}
```

After the collector:

```json
{"service":"api","level":"info","message":"ok","attrs":{"lat":"51.51","lng":"-0.13","latlng":"51.51,-0.13","client_ip":"8.8.8.8","user_id":"42","usr":"42","country":"US"}}
```

Then `usr:42`, `country:US`, and Top-N on `latlng` work.

### Vector enrichment

This example uses `remap` plus a local GeoLite / GeoIP MMDB. Run it before the `toposcope` sink; the sink input becomes `[enrich]`.

```yaml
enrichment_tables:
  geoip_table:
    type: geoip
    path: /etc/vector/GeoLite2-City.mmdb

transforms:
  enrich:
    type: remap
    inputs: [your_source]
    source: |-
      if exists(.user_id) && !exists(.usr) {
        .usr = .user_id
      }
      if .service == "api" && exists(.lat) && exists(.lng) {
        lat, err_lat = to_float(.lat)
        lng, err_lng = to_float(.lng)
        if err_lat == null && err_lng == null {
          .latlng = to_string(round(lat, 2)) + "," + to_string(round(lng, 2))
        }
      }
      if exists(.duration_ms) {
        ms, err = to_float(.duration_ms)
        if err == null {
          .duration_ms = round(ms)
        }
      }
      if exists(.client_ip) {
        geo, err = get_enrichment_table_record("geoip_table", { "ip": .client_ip })
        if err == null && exists(geo.country_code) {
          .country = geo.country_code
        }
      }
```

### Alloy enrichment

Alloy uses the same four operations. Round `lat` and `lng` before the concat because OTTL has no `round`; otherwise Top-N on `latlng` stays unique per event.

```hcl
otelcol.processor.transform "enrich" {
  error_mode = "ignore"

  log_statements {
    context = "log"
    conditions = [
      `resource.attributes["service.name"] == "api"`,
    ]
    statements = [
      `set(attributes["usr"], attributes["user_id"]) where attributes["user_id"] != nil and attributes["usr"] == nil`,
      `set(attributes["latlng"], Concat([attributes["lat"], attributes["lng"]], ",")) where attributes["lat"] != nil and attributes["lng"] != nil`,
      `set(attributes["duration_ms"], Int(Double(attributes["duration_ms"]))) where attributes["duration_ms"] != nil`,
      `set(attributes["country"], attributes["geo.country.iso_code"]) where attributes["geo.country.iso_code"] != nil`,
    ]
  }
}
```

## Syslog

RFC 3164 syslog is accepted on UDP `127.0.0.1:5514`.

```bash
echo '<27>Aug 14 01:02:03 api-1 nginx: timeout' | nc -u -w1 127.0.0.1 5514
```

UDP has no delivery acknowledgement or HTTP-style backpressure. Use a collector and HTTP ingest when delivery and buffering matter.

## Notes

- `http/protobuf` is the default OTLP HTTP encoding.
- JSON works for OTLP logs, traces, and profiles.
- Profiles are still Alpha in the collector chain; store what arrives and join only samples with a `trace_id` + `span_id` link.

## Related documentation

- [Query language](query.md)
- [Operations](operations.md)
- [Architecture](ARCHITECTURE.md)
