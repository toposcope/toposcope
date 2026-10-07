# Ingest

Toposcope accepts logs, metrics, change marks, probes, traces, and profiles over HTTP. An app speaks OpenTelemetry to it: OTLP over HTTP to `POST /v1/logs`, the same way on a laptop and in production. A collector in between is optional; when there is one, the canonical collector is Vector.

Use the same ingest token for `POST /v1/logs`, `POST /v1/metrics`, `POST /v1/marks`, `POST /v1/probes`, `POST /v1/traces`, and `POST /v1/profiles`. Toposcope does not ship a default ingest token.

## What an app sends

Hunt reads what is on the row, and a request can return 200 and still leave a row with no fingerprint. This is what has to arrive.

### Every row

- `service` — on OTLP, the resource’s `service.name`; without one the row is stored under `otlp`.
- `level` — `debug`, `info`, `warn`, `error`, or `fatal`; on OTLP, the record’s severity.
- `message` — a string. An OTLP record whose body is not a string is dropped.
- An event time with a zone — `ts` in RFC 3339, or `timeUnixNano` on OTLP. Without one the row is stamped on arrival.
- The release — `service.version` on the OTLP resource, or `version` in `attrs`. It is stored as `version`.

### An error row

The exception goes on the log record: `exception.type`, and either `exception.stacktrace` (the stack as the runtime prints it) or `exception.frames` (an array of `{ file, function, in_app? }`). Then `e1` comes from the frames and survives a reworded message; otherwise it falls back to the type and the message. An exception recorded only on a span never becomes a log row. See [Exception fingerprints](#exception-fingerprints).

### Attributes

A key starts with a letter or `_`, then letters, digits, `_`, or `.`, and is stored in lower case. `level`, `service`, `host`, `ts`, `message`, and `tenant_id` are taken. A row keeps 50 attributes. A key that breaks the rule, or one past the cap, is dropped with a 200. Nested values become JSON strings.

### Three ways in

**An OpenTelemetry exporter in the app** is the default, on a laptop and in production. It sends OTLP over HTTP (`http/protobuf` or `http/json`, not gRPC) with the ingest token, a service name, and a version. OTLP metrics are not taken yet, so that exporter stays off.

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:8080
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20${TOPOSCOPE_INGEST_TOKEN}
OTEL_SERVICE_NAME=billing
OTEL_RESOURCE_ATTRIBUTES=service.version=1.4.2
OTEL_LOGS_EXPORTER=otlp
OTEL_METRICS_EXPORTER=none
```

The app’s logger has to be bridged to the exporter, and an uncaught error logged through it with the exception attached. What arrives:

```bash
curl -X POST http://127.0.0.1:8080/v1/logs \
  -H "authorization: Bearer ${TOPOSCOPE_INGEST_TOKEN}" \
  -H 'content-type: application/json' \
  -d '{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"billing"}},{"key":"service.version","value":{"stringValue":"1.4.2"}}]},"scopeLogs":[{"logRecords":[{"timeUnixNano":"1772360100000000000","severityNumber":17,"severityText":"ERROR","body":{"stringValue":"charge failed"},"attributes":[{"key":"exception.type","value":{"stringValue":"TypeError"}},{"key":"exception.stacktrace","value":{"stringValue":"TypeError: charge failed\n    at charge (/app/src/billing.js:41:9)\n    at processPayment (/app/src/api.js:88:5)"}}]}]}]}]}'
```

**A collector reading the app’s log output** sets the same fields before it sends OTLP. Parsing a stack out of a log line is its job; ingest does not do it.

**A direct post** needs neither, and suits a laptop. The same row:

```bash
curl -X POST http://127.0.0.1:8080/api/ingest \
  -H "authorization: Bearer ${TOPOSCOPE_INGEST_TOKEN}" \
  -H 'content-type: application/json' \
  -d '{"ts":"2026-03-01T10:15:00.000Z","service":"billing","level":"error","message":"charge failed","attrs":{"version":"1.4.2","exception.type":"TypeError","exception.stacktrace":"TypeError: charge failed\n    at charge (/app/src/billing.js:41:9)\n    at processPayment (/app/src/api.js:88:5)"}}'
```

A collector between the app and Toposcope is optional. Add one when logs must outlive a Toposcope outage longer than an exporter’s retries, or when rows need enrichment. Then it is [Vector](#vector).

### What a reply means

| Status | Meaning | Sender |
| --- | --- | --- |
| `200` | Stored. `ingested` counts rows, not what each row kept. | — |
| `400` | Unreadable body, an invalid row, or a batch over the [cap](#limits-and-responses). Nothing stored. | Fix it; an exporter does not retry, so the batch is gone. |
| `401` | Missing or wrong token. | Fix the header. |
| `413` | Over 1 MB decoded. | Send smaller batches. |
| `429` | ClickHouse is busy; `Retry-After: 1`. | Retry. |
| `503` | Not ready, or the insert failed. | Retry. |

## Create an ingest token

Create a named token from the HTTP API. The token value is shown once.

```bash
curl -u "toposcope:${TOPOSCOPE_PASSWORD}" -X POST http://127.0.0.1:8080/api/api-tokens \
  -H 'content-type: application/json' \
  -d '{"name":"vector"}'
```

## Limits and responses

HTTP ingest bodies are limited to 1 MB decoded. The OTLP routes — `POST /v1/logs`, `POST /v1/traces`, and `POST /v1/profiles` — take up to 1,024 log records, spans, or profiles in a request: twice the 512 an OpenTelemetry exporter batches by default. Every other endpoint takes at most 500 log events, metric points, change marks, or probes. A request over the cap is one **400** and stores nothing. OTLP logs, traces, and profiles accept `Content-Encoding: gzip` and inflate under that same cap.

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

The level comes from `severityNumber` when it is 1–24. A record with only `severityText` is read by its word: `CRITICAL`, `ALERT`, and `EMERG` are `fatal`, `SEVERE` is `error`, and a word that is not recognized is `info`.

### OTLP protobuf

This is the default path for Vector, Fluent Bit, and Alloy.

```text
POST /v1/logs
Authorization: Bearer ${TOPOSCOPE_INGEST_TOKEN}
Content-Type: application/x-protobuf
```

Collectors send the protobuf body directly on that path.

### OTLP attributes

A stored row keeps 50 attributes. On OTLP the record’s own attributes are counted first, with the frames read from its stack, then its trace and span ids, then the resource’s. A resource full of process, runtime, and host details cannot push out what the app put on the record or the trace id that View trace needs. `e1` and `version` are stamped ahead of all of them. What does not fit is dropped.

### Exception fingerprints

Send `exception.type` and either `exception.frames` or `exception.stacktrace` as attrs. Valid supplied frames take priority. Without valid frames, ingest reads known Node/V8, Python, JVM, .NET, PHP, and Go stack formats into at most 50 frames, the ones nearest the raise: the end of a Python traceback, the start of the others. The raw stacktrace stays stored. [OpenTelemetry defines stacktrace as a runtime-specific string](https://opentelemetry.io/docs/specs/semconv/registry/attributes/exception/), so unsupported formats use the fallback below.

With frames, `e1` hashes the lower-case type plus frame file/function pairs. When any supplied frame is `in_app`, only those frames are used. Hash input normalizes path separators, file URLs, drive prefixes, and trailing line/column numbers; removes `/releases/<stamp>/` for an 8–14 digit or `YYYY-MM-DD` stamp; and strips common roots (`/app`, `/src`, `/usr/src/app`, `/var/www*`, `/home/<user>`). Full relative paths are preserved; unrecognized absolute roots use the last three path segments. A PHP closure named with where it was declared (`{closure:/app/index.php:15}`) is hashed without the line, its path normalized the same way. Paths and functions are lowercased for hashing. Stored supplied frame paths keep the sender's values.

Without usable frames, an exception type or an `error`/`fatal` event hashes type plus the stabilized log body. `exception.message` does not replace that body. Ingest does not parse stacks out of `message` or use log templates. Existing rows keep their stored `e1`; corrected inputs in 0.4.9 can give an affected error a new id once at upgrade.

The six formats are tested against stacks captured from real runtimes with a framework above the error: Node 24.21.0 with Express 5.2.1, Python 3.13.16 with Flask 3.1.3, OpenJDK 21.0.12 with Spring Boot 3.5.0, .NET 10.0.12 with ASP.NET Core 10.0.12, PHP 8.5.11 with Slim 4.15.3, and Go 1.26.8 with Gin 1.12.0. OTLP logs are tested against the requests real exporters sent for one logged exception: OpenTelemetry JS 0.223.0 with pino 10.4.0, as protobuf and JSON, and OpenTelemetry Python 1.45.1 with `logging`, as protobuf (that exporter has no JSON mode). The captures and the programs behind them are in [`fixtures/ingest`](../fixtures/ingest/).

## Metrics

Metrics use the same bearer token as logs. This is not Prometheus scrape; that stays `GET /api/metrics`.

```bash
curl -X POST http://127.0.0.1:8080/v1/metrics \
  -H "authorization: Bearer ${TOPOSCOPE_INGEST_TOKEN}" \
  -H 'content-type: application/json' \
  -d '{"name":"cpu_seconds","value":0.42,"labels":{"service":"api"}}'
```

## Change marks

A deploy, flag flip, incident, or human note lives in `change_marks` on the same clock as the logs — not as a log row. `version` on an event is an ordinary attr (`version:v0.9`); OTLP resource `service.version` is aliased onto that key at ingest when `version` is unset. Search / Follow draw marks on the pinned volume histogram (lane under the bars). Extra widgets, Surroundings, and boards do not. Optional `end_ts` (must be after the start) is an incident duration, not a rewrite of `q`.

There is no PATCH, PUT, or DELETE. A valid POST is always **200**. Never 4xx because the `id` already exists.

**Open** — omit `end_ts`. Missing `ts` is stamped server-side (`now`). Supply `id` (letters, digits, `.` `_` `:` `-`) so a later close or CI retry can find it; omit `id` and ingest mints `mk_…`.

**Close** — POST the same `id` with `end_ts` while the mark is still open. The stored start stays; incoming `ts` is ignored (omit `ts` when resolving). Hunt already draws a band when `end_ts` is set.

**Already there** — same `id` without `end_ts` while still open is skipped (`ingested: 0`). That is a CI re-run of `deploy-<service>-<tag>`: the glyph stays at first ship. It does not move the start and it does not close. Same `id` after it is already closed is also skipped (not a reopen). A new incident needs a new `id`.

One JSON object returns `{ ingested, id }`. A JSON array returns `{ ingested, ids }` in request order (`id` is minted or the caller’s). Same `id` twice in one array applies in order (open then close is two inserts).

```bash
curl -X POST http://127.0.0.1:8080/v1/marks \
  -H "authorization: Bearer ${TOPOSCOPE_INGEST_TOKEN}" \
  -H 'content-type: application/json' \
  -d '{"kind":"deploy","title":"v0.9","service":"billing","id":"deploy-billing-v0.9","attrs":{"version":"v0.9","sha":"abc123","source":"ci · deploy-bot"}}'
```

```bash
# open
curl -X POST http://127.0.0.1:8080/v1/marks \
  -H "authorization: Bearer ${TOPOSCOPE_INGEST_TOKEN}" \
  -H 'content-type: application/json' \
  -d '{"kind":"incident","title":"INC-238","id":"pd-238","ts":"2026-08-25T12:00:00.000Z"}'

# close — same id, end_ts, omit ts
curl -X POST http://127.0.0.1:8080/v1/marks \
  -H "authorization: Bearer ${TOPOSCOPE_INGEST_TOKEN}" \
  -H 'content-type: application/json' \
  -d '{"kind":"incident","title":"INC-238","id":"pd-238","end_ts":"2026-08-25T13:02:00.000Z"}'
```

`kind` is `deploy`, `flag`, `incident`, or `note`. A band that has not started yet sends both `ts` and `end_ts`. A window that starts now and ends later omits `ts` and sends `end_ts`.

### GitHub Actions

On a published release (set `TOPOSCOPE_URL` and `TOPOSCOPE_INGEST_TOKEN` as repository secrets; optional `TOPOSCOPE_SERVICE` is the service name on the mark):

```yaml
- name: Mark deploy in Toposcope
  env:
    TOPOSCOPE_URL: ${{ secrets.TOPOSCOPE_URL }}
    TOPOSCOPE_INGEST_TOKEN: ${{ secrets.TOPOSCOPE_INGEST_TOKEN }}
    TOPOSCOPE_SERVICE: billing
  run: |
    curl -fsS -X POST "${TOPOSCOPE_URL}/v1/marks" \
      -H "authorization: Bearer ${TOPOSCOPE_INGEST_TOKEN}" \
      -H "content-type: application/json" \
      -d "{\"kind\":\"deploy\",\"title\":\"${GITHUB_REF_NAME}\",\"id\":\"deploy-${TOPOSCOPE_SERVICE:+${TOPOSCOPE_SERVICE}-}${GITHUB_REF_NAME}\",\"service\":\"${TOPOSCOPE_SERVICE}\",\"attrs\":{\"version\":\"${GITHUB_REF_NAME}\",\"sha\":\"${GITHUB_SHA}\",\"source\":\"github\"}}"
```

The `id` is stable for that service and tag, so a re-run is still one glyph. Omit `TOPOSCOPE_SERVICE` and the id is `deploy-<tag>`.

### GitLab CI

On a tag pipeline (CI variables `TOPOSCOPE_URL` and `TOPOSCOPE_INGEST_TOKEN`; optional `TOPOSCOPE_SERVICE`):

```yaml
mark_deploy:
  stage: deploy
  rules:
    - if: $CI_COMMIT_TAG
  script:
    - |
      curl -fsS -X POST "${TOPOSCOPE_URL}/v1/marks" \
        -H "authorization: Bearer ${TOPOSCOPE_INGEST_TOKEN}" \
        -H "content-type: application/json" \
        -d "{\"kind\":\"deploy\",\"title\":\"${CI_COMMIT_TAG}\",\"id\":\"deploy-${TOPOSCOPE_SERVICE:+${TOPOSCOPE_SERVICE}-}${CI_COMMIT_TAG}\",\"service\":\"${TOPOSCOPE_SERVICE}\",\"attrs\":{\"version\":\"${CI_COMMIT_TAG}\",\"sha\":\"${CI_COMMIT_SHA}\",\"source\":\"gitlab\"}}"
```

## Probes / liveness

A consumed check is an explicit `up=0` or `up=1` on the hunt clock — the same ingested `up` metric the Series picker already overlays. It is not a log row, not `/api/health`, and not a second Nagios. A missing pull is stored as `up=0`, not a silent green. Empty overlay buckets stay omitted (`null`); they are not a fake 0.

`POST /v1/probes` attaches a result or pulls one status URL. Same bearer/basic, 1 MB body, and 500-item batch as other ingest. Hunt paints with `metric=up` (optional `ml=service:billing`). `GET /api/probes` lists samples in a window.

**Attach** — `{ service, up: 0|1, ts?, host?, check? }`. `up` must be the number `0` or `1`. One object returns `{ ingested, up }`. An array is attach-only (`{ ingested }`).

**Pull** — one object `{ service, url }` (`http`/`https`). Toposcope GETs that URL (5s timeout) and stores `up=1` on 2xx, otherwise `up=0` (timeout, connect error, or non-2xx). Arrays cannot pull. Optional `check` is a label ident (`github`, `k8s`).

```bash
curl -X POST http://127.0.0.1:8080/v1/probes \
  -H "authorization: Bearer ${TOPOSCOPE_INGEST_TOKEN}" \
  -H 'content-type: application/json' \
  -d '{"service":"billing","up":0,"check":"github"}'
```

```bash
curl -X POST http://127.0.0.1:8080/v1/probes \
  -H "authorization: Bearer ${TOPOSCOPE_INGEST_TOKEN}" \
  -H 'content-type: application/json' \
  -d '{"service":"billing","url":"http://127.0.0.1:8081/health","check":"k8s"}'
```

```bash
curl -u "toposcope:${TOPOSCOPE_PASSWORD}" \
  "http://127.0.0.1:8080/api/probes?range=1h&service=billing"
```

### GitHub Actions

After deploy, attach the check or let Toposcope pull the status URL (set `TOPOSCOPE_PROBE_URL` when pulling):

```yaml
- name: Record billing liveness in Toposcope
  env:
    TOPOSCOPE_URL: ${{ secrets.TOPOSCOPE_URL }}
    TOPOSCOPE_INGEST_TOKEN: ${{ secrets.TOPOSCOPE_INGEST_TOKEN }}
    TOPOSCOPE_SERVICE: billing
    TOPOSCOPE_PROBE_URL: ${{ secrets.TOPOSCOPE_PROBE_URL }}
  run: |
    curl -fsS -X POST "${TOPOSCOPE_URL}/v1/probes" \
      -H "authorization: Bearer ${TOPOSCOPE_INGEST_TOKEN}" \
      -H "content-type: application/json" \
      -d "{\"service\":\"${TOPOSCOPE_SERVICE}\",\"url\":\"${TOPOSCOPE_PROBE_URL}\",\"check\":\"github\"}"
```

To attach without a pull, POST `{"service":"billing","up":0}` when the job failed, or `up:1` when it passed.

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

Direct ingest without a collector does not grow collector-style derived keys (alias/combine/bucket/lookup). Exception attrs come from the app, OTEL, or collector enrich. Ingest uses supplied frames or known `exception.stacktrace` formats and writes `e1` (16-hex SHA-256); see [exception fingerprints](#exception-fingerprints). OTEL `service.version` is aliased onto attr `version` when `version` is unset (the dotted key is dropped; sender `version` wins). `customer` and `flag` are not inferred — copy them at the collector (`customer_id` → `customer`, `feature_flag` → `flag`) so hunt can pin them as promoted columns. Existing rows are not rewritten.

Vector remap for those two identities (run before the sink):

```yaml
if exists(.customer_id) && !exists(.customer) {
  .customer = .customer_id
}
if exists(.feature_flag) && !exists(.flag) {
  .flag = .feature_flag
}
```

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
