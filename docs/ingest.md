# Ingest

This page is for anyone sending data to Toposcope: which route takes which signal, what each one accepts, its limits, and what its replies mean. To put a collector in between, see [Collectors](collectors.md). For why each key matters to an investigation, see [What an investigation reads](evidence.md).

Toposcope accepts logs, metrics, change marks, check results, probes, traces, and profiles over HTTP, and Prometheus remote write. An app speaks OpenTelemetry to it: OTLP over HTTP to `POST /v1/logs`, the same way on a laptop and in production. A collector in between is optional; when there is one, the canonical collector is Vector.

## Routes and the ingest token

Every HTTP route below takes the same ingest token, sent as `Authorization: Bearer <token>`. Toposcope does not ship a default ingest token: [create one](#create-an-ingest-token). A push monitor's keyed URL, `/ping/<key>`, is the one route that takes none: its key is the credential.

| Route | Takes | See |
| --- | --- | --- |
| `POST /v1/logs` | OTLP logs, JSON or protobuf | [Logs](#logs) |
| `POST /api/ingest` | log events as JSON or NDJSON | [Manual JSON / NDJSON](#manual-json--ndjson) |
| `POST /v1/metrics` | OTLP metrics, or plain JSON points | [Metrics](#metrics) |
| `POST /v1/prometheus/write` | Prometheus remote write 1.0 | [Prometheus remote write](#prometheus-remote-write) |
| `POST /v1/marks` | deploys, flag flips, incidents, notes | [Change marks](#change-marks) |
| `POST /v1/checks` | check results for push monitors | [Check results](#check-results-push-monitors) |
| `GET` or `POST /ping/<key>` | one check result, with no token | [The keyed URL](#the-keyed-url) |
| `POST /v1/probes` | an `up` result, or a status URL to pull | [Probes / liveness](#probes--liveness) |
| `POST /v1/traces` | OTLP spans | [Traces](#traces) |
| `POST /v1/profiles` | OTLP profiles | [Profiles](#profiles) |
| port `4319` | OTLP over gRPC: logs, traces, metrics, profiles | [OTLP over gRPC](#otlp-over-grpc) |
| UDP `127.0.0.1:5514` | RFC 3164 syslog | [Syslog](#syslog) |

## What an app sends

Hunt reads what is on the row, and a request can return 200 and still leave a row with no fingerprint. This is what has to arrive.

### Every row

- `service` — on OTLP, the resource’s `service.name`; without one the row is stored under `otlp`.
- `level` — `debug`, `info`, `warn`, `error`, or `fatal`; on OTLP, the record’s severity.
- `message` — a string. On OTLP a number or a boolean body becomes its text, and a map becomes one line — its `message` or `msg`, else the map as JSON — with its other top-level fields as attributes. A record with no body takes its event name; one with neither is not stored, and the reply counts it.
- An event time with a zone — `ts` in RFC 3339, or `timeUnixNano` on OTLP. Without one the row takes the time a collector first saw it (`observedTimeUnixNano`), or else the time it arrives.
- The release — `service.version` on the OTLP resource, or `version` in `attrs`. It is stored as `version`.

### An error row

The exception goes on the log record: `exception.type`, and either `exception.stacktrace` (the stack as the runtime prints it) or `exception.frames` (an array of `{ file, function, in_app? }`). Then `e1` comes from the frames and survives a reworded message; otherwise it falls back to the type and the message. An exception recorded on a span is kept on that span, with the same `e1`, and shows in the waterfall. It never becomes a log row, so an exception has to be logged to be hunted: fingerprints, `level:error` and Compare read logged errors. See [Exception fingerprints](#exception-fingerprints).

### Attributes

A key starts with a letter or `_`, then letters, digits, `_`, or `.`, and is stored in lower case. `level`, `service`, `host`, `toposcope`, `ts`, `message`, and `tenant_id` are taken. `toposcope` is which instance a row entered at: rows ingested on an instance with a name are stamped with it, and an attribute a sender calls `toposcope` is dropped. A row keeps 50 attributes. A key that breaks the rule, or one past the cap, is dropped with a 200; on the OTLP routes the reply says so. Nested values become JSON strings.

### Three ways in

**An OpenTelemetry exporter in the app** is the default, on a laptop and in production. It sends OTLP over HTTP (`http/protobuf` or `http/json`), or over gRPC on its own port, with the ingest token, a service name, and a version. Metrics need no setting: counters and histograms are stored as the amount per interval, whether the exporter sends deltas or, as it does by default, running totals.

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:8080
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20${TOPOSCOPE_INGEST_TOKEN}
OTEL_SERVICE_NAME=billing
OTEL_RESOURCE_ATTRIBUTES=service.version=1.4.2
OTEL_LOGS_EXPORTER=otlp
OTEL_METRICS_EXPORTER=otlp
OTEL_TRACES_EXPORTER=otlp
```

An exporter left on gRPC, which several are by default, needs the other address and no protocol line: `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4319`, with the same header. See [OTLP over gRPC](#otlp-over-grpc).

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
| `200` | Stored. `ingested` counts rows, not what each row kept. On the OTLP routes `partialSuccess` counts the records that were not stored and says in one line what was rejected or cut. | Read `partialSuccess`; an exporter logs it. |
| `400` | Unreadable body, an invalid row, or a batch over the [cap](#limits-and-responses). Nothing stored. | Fix it; an exporter does not retry, so the batch is gone. |
| `401` | Missing or wrong token. | Fix the header. |
| `404` | The token is good and the path is not an ingest route. | Fix the endpoint. |
| `413` | Over 1 MB decoded. | Send smaller batches. |
| `429` | ClickHouse is busy; `Retry-After: 1`. | Retry. |
| `503` | Not ready, or the insert failed. | Retry. |

## Create an ingest token

Create a named token in **Access › Make a token › Sending logs in**, or from the HTTP API with an Owner's personal or service account token (see [People and roles](people.md#tokens)). The token value is shown once.

This request creates an ingest token named `vector`:

```bash
curl -H "Authorization: Bearer $TOPOSCOPE_TOKEN" -X POST http://127.0.0.1:8080/api/api-tokens \
  -H 'content-type: application/json' \
  -d '{"name":"vector"}'
```

## Limits and responses

### Size and count limits

| Limit | Applies to |
| --- | --- |
| 1 MB decoded body | every HTTP ingest route |
| 1,024 log records, spans, or profiles a request | the OTLP routes: `POST /v1/logs`, `POST /v1/traces`, and `POST /v1/profiles`. That is twice the 512 an OpenTelemetry exporter batches by default. |
| No count, only the 1 MB body | OTLP on `POST /v1/metrics`, because an exporter sends every series in one request |
| 500 log events, metric points, change marks, check results, or probes a request | `/api/ingest`, plain JSON on `/v1/metrics`, `/v1/marks`, `/v1/checks`, `/v1/probes`; OTLP and remote write have only the body cap |

A request over the cap is one **400** and stores nothing. OTLP logs, traces, and profiles accept `Content-Encoding: gzip` and inflate under that same cap.

### What a successful request returns

Successful requests return the number of ingested records. An OTLP request is answered in its own encoding:

| Request | Reply |
| --- | --- |
| JSON | `{ "ingested": n }` |
| protobuf | an `Export…ServiceResponse`, empty when nothing was lost |

When records were not stored, or were stored without something they were sent with, the reply carries OTLP’s partial success, still with a **200**, and the rest of the request is stored. In JSON it reads `{ "ingested": 2, "partialSuccess": { "rejectedLogRecords": "1", "errorMessage": "no body: 1 rejected" } }`. The count is zero when everything was stored and something was cut, such as attributes past the cap.

### Errors and backpressure

Invalid batches return a `4xx` response, in JSON. When ClickHouse is overloaded or the application has no insert capacity, HTTP ingest returns `429` with `Retry-After: 1`; collectors should retry and buffer upstream. The full list of statuses is in [What a reply means](#what-a-reply-means).

## Logs

### Manual JSON / NDJSON

Use this path when you want to post events directly. This request posts one error event as NDJSON:

```bash
curl -H "Authorization: Bearer $TOPOSCOPE_INGEST_TOKEN" -X POST http://127.0.0.1:8080/api/ingest \
  -H 'content-type: application/x-ndjson' \
  --data-binary '{"service":"api","level":"error","message":"timeout"}'
```

### OTLP JSON

Use OTLP JSON when your collector is configured for HTTP JSON export. This request posts one error record as OTLP JSON:

```bash
curl -X POST http://127.0.0.1:8080/v1/logs \
  -H "authorization: Bearer ${TOPOSCOPE_INGEST_TOKEN}" \
  -H 'content-type: application/json' \
  -d '{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"api"}}]},"scopeLogs":[{"logRecords":[{"severityText":"ERROR","body":{"stringValue":"timeout"}}]}]}]}'
```

For collectors, set `OTEL_EXPORTER_OTLP_PROTOCOL=http/json` and `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:8080`. JSON works for OTLP logs, traces, and profiles.

The level comes from `severityNumber` when it is 1–24. A record with only `severityText` is read by its word:

| `severityText` | Level |
| --- | --- |
| `CRITICAL`, `ALERT`, `EMERG` | `fatal` |
| `SEVERE` | `error` |
| a word that is not recognized | `info` |

### OTLP protobuf

`http/protobuf` is the default OTLP HTTP encoding, and the default path for Vector, Fluent Bit, and Alloy. Collectors send the protobuf body directly on `POST /v1/logs` with these headers:

```text
POST /v1/logs
Authorization: Bearer ${TOPOSCOPE_INGEST_TOKEN}
Content-Type: application/x-protobuf
```

### OTLP attributes

A stored row keeps 50 attributes. On OTLP they are counted in this order, and what does not fit is dropped:

1. `e1` and `version`, stamped ahead of all the others.
2. The record’s own attributes, with the frames read from its stack.
3. A map body’s top-level fields.
4. Its trace and span ids.
5. The logger’s name: the OTLP scope’s name, stored as `otel.scope.name`.
6. The resource’s attributes.

So a resource full of process, runtime, and host details cannot push out what the app put on the record, or the trace id that View trace needs.

A span (`POST /v1/traces`) is kept the same way: its recorded exception and `e1` first, then its own attributes and its status message, then the resource’s. A key on both keeps the span’s value.

## Exception fingerprints

An error row's fingerprint, `e1`, is what Fingerprints, Home and Compare group an error by. Send `exception.type` and either `exception.frames` or `exception.stacktrace` as attrs. Valid supplied frames take priority.

### Stacks ingest reads

Without valid frames, ingest reads known stack formats into at most 50 frames, the ones nearest the raise. The raw stacktrace stays stored.

| Format | Frames kept |
| --- | --- |
| Python | the end of the traceback |
| Node/V8, JVM, .NET, PHP, Go | the start of the stack |

[OpenTelemetry defines stacktrace as a runtime-specific string](https://opentelemetry.io/docs/specs/semconv/registry/attributes/exception/), so unsupported formats use the [fallback without frames](#an-id-without-frames).

### How frames become an id

With frames, `e1` hashes the lower-case type plus frame file/function pairs. When any supplied frame is `in_app`, only those frames are used. The hash input is normalized so the same code gives the same id across machines and releases:

- Path separators, file URLs, drive prefixes, and trailing line/column numbers are normalized.
- `/releases/<stamp>/` is removed, for an 8–14 digit or `YYYY-MM-DD` stamp.
- Common roots are stripped: `/app`, `/src`, `/usr/src/app`, `/var/www*`, `/home/<user>`.
- Full relative paths are preserved; unrecognized absolute roots use the last three path segments.
- A PHP closure named with where it was declared (`{closure:/app/index.php:15}`) is hashed without the line, its path normalized the same way.
- Paths and functions are lowercased for hashing.

Stored supplied frame paths keep the sender's values; only the hash input is normalized. The id is 16 hex characters.

### An id without frames

Without usable frames, an exception type or an `error`/`fatal` event hashes type plus the stabilized log body. `exception.message` does not replace that body. Ingest does not parse stacks out of `message` or use log templates.

### When the rules change

Existing rows keep their stored `e1`. An upgrade that corrects the hash inputs can give an affected error a new id once; the [CHANGELOG](../CHANGELOG.md) names the releases that did.

The key says which rules made the id: `e1` is the rules above, and when the hash inputs change again new rows carry `e2`. The bar takes either, and a pulled row keeps the key its source gave it. A sender's own `e1`, `e2`, … are dropped: only the store's rules make an id.

### Tested runtimes and exporters

The six formats are tested against stacks captured from real runtimes with a framework above the error:

| Runtime | Framework |
| --- | --- |
| Node 24.21.0 | Express 5.2.1 |
| Python 3.13.16 | Flask 3.1.3 |
| OpenJDK 21.0.12 | Spring Boot 3.5.0 |
| .NET 10.0.12 | ASP.NET Core 10.0.12 |
| PHP 8.5.11 | Slim 4.15.3 |
| Go 1.26.8 | Gin 1.12.0 |

OTLP logs are tested against the requests real exporters sent for one logged exception:

| Exporter | Logger | Encodings |
| --- | --- | --- |
| OpenTelemetry JS 0.223.0 | pino 10.4.0 | protobuf and JSON |
| OpenTelemetry Python 1.45.1 | `logging` | protobuf (that exporter has no JSON mode) |

The captures and the programs behind them are in [`fixtures/ingest`](../fixtures/ingest/).

## Metrics

Metrics use the same bearer token as logs. Toposcope does not scrape: something sends to it, an app over OTLP, or Prometheus and its kin over [remote write](#prometheus-remote-write). `GET /api/metrics` is Toposcope's own numbers, for a Prometheus to scrape.

`POST /v1/metrics` takes two shapes: OTLP from an OpenTelemetry exporter (JSON, protobuf, or either gzipped), and a [plain JSON point](#a-plain-json-point).

### OTLP metric kinds

From OTLP, what fits a point is stored by its kind:

| Kind | Stored as | A bar on the plot |
| --- | --- | --- |
| **gauge** | as it is. An up-down counter’s running total is a level, so it is a gauge too. | the average of its points |
| **counter** | the amount per interval | the sum of what arrived in it; a wider bar sums more |
| **histogram** | its buckets, under one name, plus the counters `<name>.count` and `<name>.sum` | one reading at a time: `count`, `sum`, `avg`, `p50`, `p90` or `p99` |
| **summary** | two counters: `<name>.count` and `<name>.sum` | as a counter |

A summary's quantiles were worked out by the sender and cannot be added up, so they are not kept.

A histogram percentile is read off the buckets of every matching series added together, so it is as exact as the buckets are wide; past the highest bound it is that bound. An exponential histogram is brought to the same shape, kept no finer than eight buckets to a doubling. A link that names `<name>.count` or `<name>.sum` draws that reading.

### Name, unit, description and labels

- **Kind.** A name remembers the kind it came as, and that decides how the plot and every widget read it. Dotted names are kept as they are.
- **Unit.** A name remembers the unit it was last sent with, as sent (`s`, `By`, `GiBy`, `{request}`); nothing is converted, and a point sent without one leaves it as it was.
- **Unit of a histogram or summary.** It is the unit of its values and its sum, not of its count.
- **Description.** A name remembers the description it was last sent with, the sentence the metric's author wrote about it, cut to 300 characters. A point sent without one leaves it as it was.
- **Labels.** A point’s attributes become labels, then the resource’s; `service.name` and `host.name` arrive as `service` and `host`.

### Running totals and deltas

A counter, a histogram or a summary may arrive as deltas or as a running total since the process started, which is what an exporter sends by default. A running total is converted on the way in: Toposcope keeps the last total of each series in memory and stores the difference. A series that restarts is counted from its new start, and an export that never arrived is made up by the next one. The reply says how many points were taken that way.

The one cost is a restart of Toposcope itself: the first total it then sees from a series that was already running is only a baseline, so that series loses what it counted since its last stored export.

### What a metrics request rejects

These are counted as rejected in the reply’s partial success, with a **200**, and the rest of the request is stored:

- a sum or histogram that does not say whether it is a delta or a running total;
- a name outside letters, digits, `_` and `.`.

Histogram buckets that do not fit their bounds are a warning; the count and sum still land.

### A plain JSON point

The other shape is a plain JSON point or an array of up to 500. It has no kind and reads as a gauge. It may carry a `unit`, a string of up to 64 characters, and a `description` of up to 300. This request sends one point of `cpu_seconds` for the `api` service:

```bash
curl -X POST http://127.0.0.1:8080/v1/metrics \
  -H "authorization: Bearer ${TOPOSCOPE_INGEST_TOKEN}" \
  -H 'content-type: application/json' \
  -d '{"name":"cpu_seconds","value":0.42,"unit":"s","description":"CPU time the job used.","labels":{"service":"api"}}'
```

### Prometheus remote write

A Prometheus that already scrapes your exporters sends what it scrapes to `POST /v1/prometheus/write`, with the ingest token. Its scrape config and exporters stay as they are.

1. Put the ingest token, alone, in a file Prometheus can read.
2. Add this `remote_write` block to the Prometheus config:

```yaml
remote_write:
  - url: http://127.0.0.1:8080/v1/prometheus/write
    authorization:
      credentials_file: /etc/prometheus/toposcope-token   # the ingest token, alone in the file
```

Prometheus in agent mode, Grafana Alloy (`prometheus.remote_write`) and Vector (`prometheus_remote_write`) send the same request. It is remote write 1.0, protobuf compressed with snappy, at most 1 MB decompressed; Prometheus's default batch of 2,000 samples fits. A 2.0 request gets **415**, and Prometheus falls back to 1.0.

### How remote write series are stored

Each series is stored the way the same metric would be from OTLP:

- A name ending `_total`, or one Prometheus's metadata calls a counter, is a **counter**: its running total becomes the amount per interval.
- `_bucket` series with `le` are a **histogram**'s buckets, under the name without `_bucket`, read as `avg` or a percentile like any histogram; `_count` and `_sum` become `<name>.count` and `<name>.sum`.
- A **summary** keeps `<name>.count` and `<name>.sum`; its `quantile` series are not stored.
- Everything else is a **gauge**. Metadata that calls a name a gauge wins over its suffix.

Names keep Prometheus's spelling, in lower case: `node_cpu_seconds_total`, `node_memory_memavailable_bytes`. A name with a `:`, as a recording rule's has, cannot be stored. Labels become labels. `job` is also the series' `service`, and `instance`, without its port, its `host`, unless the series has labels of those names.

### When remote write series appear

Prometheus does not say when a series started, so the first total Toposcope sees of each counter is only its baseline, after every restart of Toposcope too: that series is counted from its second scrape.

A histogram's bucket series come in pieces, spread over parallel requests, so its buckets are held until the same histogram's next scrape, or 30 seconds, and are written whole; on a stop they are written at once. Stale markers are not stored, and native histograms are not read yet.

### Remote write replies

| Status | Meaning | Prometheus |
| --- | --- | --- |
| `204` | Stored. | |
| `400` | Unreadable body. Nothing stored. | Drops the batch. |
| `401` | Missing or wrong token. | Drops the batch. |
| `413` | Over 1 MB decompressed. | Lower `queue_config.max_samples_per_send`. |
| `415` | Remote write 2.0, or an encoding other than snappy. | 2.0 falls back to 1.0. |
| `429` | ClickHouse is busy; `Retry-After: 1`. | Retries. |
| `503` | Not ready, or the insert failed. | Retries. |

## Change marks

A change mark is a deploy, flag flip, incident, or human note, kept on the same clock as the logs but not as a log row. `kind` is `deploy`, `flag`, `incident`, or `note`. Search and Follow draw marks on the pinned volume histogram, in the lane under the bars; extra widgets, Surroundings, and boards do not.

`version` on an event is an ordinary attr (`version:v0.9`); OTLP resource `service.version` is aliased onto that key at ingest when `version` is unset.

### Send a mark

This request marks the deploy of billing `v0.9`, with its commit and repository:

```bash
curl -X POST http://127.0.0.1:8080/v1/marks \
  -H "authorization: Bearer ${TOPOSCOPE_INGEST_TOKEN}" \
  -H 'content-type: application/json' \
  -d '{"kind":"deploy","title":"v0.9","service":"billing","id":"deploy-billing-v0.9","attrs":{"version":"v0.9","sha":"abc123","repo":"https://github.com/acme/billing","source":"ci · deploy-bot"}}'
```

Supply `id` (letters, digits, `.` `_` `:` `-`) so a later close or CI retry can find it; omit `id` and ingest mints `mk_…`. A missing `ts` is stamped server-side (`now`).

| Request | Reply |
| --- | --- |
| one JSON object | `{ ingested, id }` |
| a JSON array | `{ ingested, ids }` in request order; each `id` is minted or the caller’s |

The same `id` twice in one array applies in order: open then close is two inserts.

### Open, close, and send again

There is no PATCH, PUT, or DELETE. A valid POST is always **200**, never 4xx because the `id` already exists.

| You send | What happens |
| --- | --- |
| **Open**: no `end_ts` | The mark starts at `ts`, or now. |
| **Close**: the same `id` with `end_ts`, while the mark is still open | The stored start stays; incoming `ts` is ignored (omit `ts` when resolving). Hunt draws a band once `end_ts` is set. |
| **Already there**: the same `id` again | A CI re-run of `deploy-<service>-<tag>`: the same `id` without `end_ts` while still open is skipped (`ingested: 0`). The glyph stays at first ship; it does not move the start and it does not close. |
| The same `id` after it is closed | Also skipped: not a reopen. A new incident needs a new `id`. |

Optional `end_ts` must be after the start. It is an incident duration, not a rewrite of `q`. A band that has not started yet sends both `ts` and `end_ts`. A window that starts now and ends later omits `ts` and sends `end_ts`.

These two requests open incident INC-238 and then close it an hour later:

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

### GitHub Actions

To mark each published release:

1. Set `TOPOSCOPE_URL` and `TOPOSCOPE_INGEST_TOKEN` as repository secrets.
2. Optionally set `TOPOSCOPE_SERVICE`, the service name on the mark.
3. Add this step to the job that runs on a published release:

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
      -d "{\"kind\":\"deploy\",\"title\":\"${GITHUB_REF_NAME}\",\"id\":\"deploy-${TOPOSCOPE_SERVICE:+${TOPOSCOPE_SERVICE}-}${GITHUB_REF_NAME}\",\"service\":\"${TOPOSCOPE_SERVICE}\",\"attrs\":{\"version\":\"${GITHUB_REF_NAME}\",\"sha\":\"${GITHUB_SHA}\",\"repo\":\"${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}\",\"source\":\"github\"}}"
```

The `id` is stable for that service and tag, so a re-run is still one glyph. Omit `TOPOSCOPE_SERVICE` and the id is `deploy-<tag>`.

### GitLab CI

To mark each tag pipeline:

1. Set `TOPOSCOPE_URL` and `TOPOSCOPE_INGEST_TOKEN` as CI variables.
2. Optionally set `TOPOSCOPE_SERVICE`.
3. Add this job:

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
        -d "{\"kind\":\"deploy\",\"title\":\"${CI_COMMIT_TAG}\",\"id\":\"deploy-${TOPOSCOPE_SERVICE:+${TOPOSCOPE_SERVICE}-}${CI_COMMIT_TAG}\",\"service\":\"${TOPOSCOPE_SERVICE}\",\"attrs\":{\"version\":\"${CI_COMMIT_TAG}\",\"sha\":\"${CI_COMMIT_SHA}\",\"repo\":\"${CI_PROJECT_URL}\",\"source\":\"gitlab\"}}"
```

## Check results (push monitors)

A script, a cron job, a Nagios plugin or a box with no logs tells Toposcope how it went. Toposcope never runs the check; it keeps the result, and a push monitor opens on a fail or when a result does not come.

### Send a result

`POST /v1/checks` takes one result or up to 500, with the ingest token (1 MB, JSON or NDJSON). This request reports `/var` at 87% used as a warn, with the next result due in 5 minutes:

```bash
curl -X POST http://127.0.0.1:8080/v1/checks \
  -H "authorization: Bearer ${TOPOSCOPE_INGEST_TOKEN}" \
  -H 'content-type: application/json' \
  -d '{"monitor":"disk-var","status":"warn","message":"/var 87% used","value":87.2,"unit":"%","every":"5m","grace":"2m","host":"log-vm","service":"box-agent"}'
```

| Field | Meaning |
| --- | --- |
| `monitor` | Required. Names its monitor: at most 100 characters, no `"`. A name not seen before creates a push monitor, up to 500; past that the request is refused and says why. A name a saved-search monitor has is refused. |
| `status` | Required. `ok`, `warn` or `fail`, or `0`–`3`: Nagios's ok, warning, critical and unknown, so a plugin's exit code is a status. |
| `every` | `30s` to `365d`. When the next result is due. |
| `grace` | `0` to `365d`. How long past `every` the monitor waits before it opens. |
| `message` | Optional. |
| `value`, `unit` | Optional. A `value` is also the metric `monitor_value`. |
| `host` | Optional. |
| `service` | Optional; else `monitor`. |
| `ts` | Optional; else now. |
| `exit_code` | Optional, 0–255. A numeric status is its own. |
| `duration_ms` | Optional. |

The reply is `{ ingested, created }`, the names it made monitors for. A bad result refuses the whole request, `result <n>: …`, and stores nothing.

### What a status and a missing result do

| Status | The monitor |
| --- | --- |
| `fail` (`2`) | opens |
| `ok` (`0`) | resolves an open monitor |
| `warn` (`1`) | shows on Watch and calls nobody |
| unknown (`3`) | changes nothing |

Past `every` with nothing in, the monitor is late; past `every` + `grace` it opens. Without a grace of its own it waits one more `every`, at most an hour. A result that leaves `every` and `grace` out keeps the monitor's; without `every` a monitor goes by its results alone and is never late.

### Where a result shows

Every result is a log row: `monitor:<name> status:<status> source:push`, with its message, host and service, its `exit_code`, and `duration_ms` when it has one, so `monitor:disk-var` finds them in Search. A fail is an `error` row, a warn a `warn`.

A `value` is also the metric `monitor_value`, labelled `monitor`, for the Series overlay. Toposcope never compares the value with anything: the check decides ok, warn or fail.

### The keyed URL

For a cron line with no token, each push monitor has `/ping/<key>`, shown on its page and in its editor. It takes a GET or a POST with no header, as Healthchecks' ping URL does, so a job wrapped by `runitor` or `hc-ping` points at Toposcope by changing the host:

| Path | Means |
| --- | --- |
| `/ping/<key>` | ok |
| `/ping/<key>/fail` | fail |
| `/ping/<key>/<exit code>` | 0 is ok, 1–255 a fail |
| `/ping/<key>/start` | a run began: the next result's `duration_ms` is measured from here, and Watch draws the run as a bar |

A POST body, up to 10 KB, is the message; the rest is not read. A start is a row too (`monitor:<name> signal:start source:push`). An unknown key gets `404` and writes nothing, in the time a known one takes. A key stores at most one start and one result a second; more get `429`.

This crontab line runs a backup at 02:00 and sends its exit code as the result:

```bash
0 2 * * * /usr/local/bin/backup.sh; curl -fsS -m 10 https://toposcope.example.com/ping/<key>/$?
```

### A command's result

The [toposcope skill](../skills/toposcope/SKILL.md)'s `toposcope.sh check <monitor> -- <command>` runs any command and sends its exit code, how long it ran and the tail of its output. For a Nagios plugin, the first line is the message and its first perfdata value is the value. It sends to `TOPOSCOPE_URL` with `TOPOSCOPE_INGEST_TOKEN`.

This runs the Nagios disk plugin on `/var` and sends its result to the `disk-var` monitor:

```bash
toposcope.sh check disk-var -- /usr/lib/nagios/plugins/check_disk -w 20% -c 10% -p /var
```

## Probes / liveness

A consumed check is an explicit `up=0` or `up=1` on the hunt clock: the same ingested `up` metric the Series picker already overlays. It is not `/api/health`, and not a second Nagios. A missing pull is stored as `up=0`, not a silent green. Empty overlay buckets stay omitted (`null`); they are not a fake 0.

`POST /v1/probes` attaches a result or pulls one status URL, with the same bearer token, 1 MB body, and 500-item batch as other ingest. Hunt paints with `metric=up` (optional `ml=service:billing`).

### Attach a result

Send `{ service, up: 0|1, ts?, host?, check? }`. `up` must be the number `0` or `1`. One object returns `{ ingested, up }`. An array is attach-only (`{ ingested }`).

An attached probe is also a push monitor's result: `up` 1 is ok, 0 a fail, and `check` names the monitor (its `service` without one). So it is a log row too, and opens and resolves that monitor.

This request records that billing's `github` check is down:

```bash
curl -X POST http://127.0.0.1:8080/v1/probes \
  -H "authorization: Bearer ${TOPOSCOPE_INGEST_TOKEN}" \
  -H 'content-type: application/json' \
  -d '{"service":"billing","up":0,"check":"github"}'
```

### Pull a status URL

Send one object `{ service, url }` (`http`/`https`). Toposcope GETs that URL (5s timeout) and stores `up=1` on 2xx, otherwise `up=0` (timeout, connect error, or non-2xx). Arrays cannot pull. Optional `check` is a label ident (`github`, `k8s`). A pulled result is only `up`: it is not a push monitor's result.

This request has Toposcope pull billing's health endpoint and store the result under `k8s`:

```bash
curl -X POST http://127.0.0.1:8080/v1/probes \
  -H "authorization: Bearer ${TOPOSCOPE_INGEST_TOKEN}" \
  -H 'content-type: application/json' \
  -d '{"service":"billing","url":"http://127.0.0.1:8081/health","check":"k8s"}'
```

### List probe samples

`GET /api/probes` lists samples in a window. This request lists billing's samples from the last hour:

```bash
curl -H "Authorization: Bearer $TOPOSCOPE_TOKEN" \
  "http://127.0.0.1:8080/api/probes?range=1h&service=billing"
```

### GitHub Actions

After deploy, attach the check or let Toposcope pull the status URL. Set `TOPOSCOPE_PROBE_URL` when pulling. This step has Toposcope pull the URL:

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

Toposcope stores the spans it receives. Sampling stays at the collector. `POST /v1/traces` takes OTLP JSON, and `Content-Type: application/x-protobuf` on the same path.

This request posts one 412 ms `GET /` span from nginx as OTLP JSON:

```bash
curl -X POST http://127.0.0.1:8080/v1/traces \
  -H "authorization: Bearer ${TOPOSCOPE_INGEST_TOKEN}" \
  -H 'content-type: application/json' \
  -d '{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"nginx"}}]},"scopeSpans":[{"spans":[{"traceId":"aabbccddeeff00112233445566778899","spanId":"1122334455667788","name":"GET /","startTimeUnixNano":"1692000000000000000","endTimeUnixNano":"1692000000412000000","status":{"code":1}}]}]}]}'
```

### Exceptions on a span

A span keeps the exception recorded on it: the `exception` event a tracing library writes with `recordException`, or by itself when an exception leaves the span. Its `exception.type`, `exception.message` and `exception.stacktrace` are stored on the span with the `e1` they give, by the same rules as a log row, so the span and the row that logged the same exception carry the same id. When a span recorded several, the last is kept. Other span events are not stored.

The tracing library’s own frames at the outer ends of a span’s stack are left out of the id: the Python library records an exception as it passes through its own context managers, and the logged traceback never has those frames.

The spans themselves are tested against what OpenTelemetry JS 0.223.0 and OpenTelemetry Python 1.45.1 send.

## Profiles

Profiles use the same bearer token. Toposcope stores what arrives and joins only samples that carry both a `trace_id` and a `span_id` link. Profiles are still Alpha in the collector chain. Toposcope does not use `/debug/pprof` scraping.

This request posts a protobuf profile from a file:

```bash
curl -X POST http://127.0.0.1:8080/v1/profiles \
  -H "authorization: Bearer ${TOPOSCOPE_INGEST_TOKEN}" \
  -H 'content-type: application/x-protobuf' \
  --data-binary @profile.pb
```

## OTLP over gRPC

Several OpenTelemetry exporters send gRPC unless told otherwise. Toposcope takes it on a second port, `4319`, for logs, traces, metrics and profiles. The token is the same, sent as the `authorization` metadata an exporter builds from `OTEL_EXPORTER_OTLP_HEADERS`. These two settings point an exporter at it:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4319
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20${TOPOSCOPE_INGEST_TOKEN}
```

### gRPC limits and codes

A call behaves as the HTTP route for its signal, so the limits and the replies are the ones on this page: 1 MB a message, gzip under that, 1,024 log records or spans, and a reply whose partial success says what was not stored. What HTTP answers with a status, gRPC answers with a code:

| HTTP | gRPC | An exporter |
| --- | --- | --- |
| 200 | `OK` | goes on |
| 400 | `INVALID_ARGUMENT` | drops the request |
| 401 | `UNAUTHENTICATED` | drops the request |
| 413 | `RESOURCE_EXHAUSTED` | drops the request |
| 429, 503 | `UNAVAILABLE` | tries again |

### The gRPC port

The port is `4319` and not OTLP’s usual `4317`, which is left to a collector on the same host: the packaged [Vector](collectors.md#vector) config listens there. `OTLP_GRPC_PORT` moves it, and `0` turns it off. The packaged install binds it to `127.0.0.1`, like the app’s port. It is plain HTTP/2 with no TLS; in front of a reverse proxy it needs a rule of its own, shown in the [operations guide](operations.md#tls).

Tested with OpenTelemetry Python 1.45.1 on its gRPC default, OpenTelemetry JS 0.223.0 with `OTEL_EXPORTER_OTLP_PROTOCOL=grpc`, and the OpenTelemetry Collector 0.162.0.

## Vector

Moved to [Collectors › Vector](collectors.md#vector).

## Fluent Bit

Moved to [Collectors › Fluent Bit](collectors.md#fluent-bit).

## Alloy

Moved to [Collectors › Alloy](collectors.md#alloy).

## Enrich at the collector

Moved to [Collectors › Enrich at the collector](collectors.md#enrich-at-the-collector).

## Syslog

RFC 3164 syslog is accepted on UDP `127.0.0.1:5514`. This sends one line from `nginx` on `api-1`:

```bash
echo '<27>Aug 14 01:02:03 api-1 nginx: timeout' | nc -u -w1 127.0.0.1 5514
```

UDP has no delivery acknowledgement or HTTP-style backpressure. Use a collector and HTTP ingest when delivery and buffering matter.

### Dropped syslog rows

At most 10,000 syslog rows wait to be stored. These are dropped, and `GET /api/metrics` counts each:

| Dropped | Counted in |
| --- | --- |
| a packet that arrives when all 10,000 are waiting | `toposcope_syslog_dropped_total{reason="queue_full"}` |
| a batch of up to 500 whose insert fails | `toposcope_syslog_dropped_total{reason="insert_failed"}` |
| a packet that is not RFC 3164 | `toposcope_syslog_dropped_total{reason="unparsed"}` |

While drops happen, the app writes at most one line a minute to stderr with the counts since the last one. `toposcope_syslog_packets_total` counts the packets taken.

## Related documentation

- [Collectors](collectors.md)
- [What an investigation reads](evidence.md)
- [Query language](query.md)
- [Hunting](hunt.md)
- [Operations](operations.md)
- [Architecture](ARCHITECTURE.md)
