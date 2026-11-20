# Collectors

This page is for whoever runs a collector between apps and Toposcope: Vector, the canonical one, then Fluent Bit and Alloy, and the keys a collector can add on the way. The routes, limits and replies a collector meets are in the [ingest guide](ingest.md).

## When to add a collector

A collector between the app and Toposcope is optional, and without one nothing else changes: the app exports straight to Toposcope. Add one when what the app sends must outlive a Toposcope outage longer than its exporter keeps retrying, or when rows need enrichment on the way.

A collector that reads the app’s log output sets the fields in [What an app sends](ingest.md#what-an-app-sends) before it sends OTLP. Parsing a stack out of a log line is its job; ingest does not do it.

## Vector

The shipped `vector.yaml` is that collector, for Vector 0.51 or newer. Vector listens for OTLP from apps, over HTTP on port 4318 and gRPC on 4317, keeps what it receives on disk until Toposcope has taken it, and forwards each request as the app sent it, to `/v1/logs`, `/v1/traces` and `/v1/metrics`. It also sends the machine's own [host metrics](#host-metrics) and any [`/metrics` page you list](#scrape-a-metrics-page).

### Run Vector

1. Put the ingest token in `.env` as `TOPOSCOPE_INGEST_TOKEN`. Set `TOPOSCOPE_URL` too when Toposcope is not at `http://127.0.0.1:8080`.
2. Run Vector where the app can reach it. `VECTOR_DATA_DIR` is where the disk buffers are kept, `/var/lib/vector` when unset:

```bash
set -a && source .env && set +a
VECTOR_DATA_DIR=vector-data vector -c vector.yaml
```

3. Point the app at Vector. The app changes one setting, the address, and needs no token, because Vector adds it:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
```

The file also holds the smoke source the quick start uses: three events under `service:smoke` on every start.

### What Vector does with a request

- Over HTTP the app sends protobuf (`http/protobuf`, an exporter’s default). Vector does not take OTLP as JSON.
- Each signal has its own disk buffer of 256 MB. When one is full Vector holds the app back; it does not drop.
- A request Toposcope cannot take yet, because it is down or busy, is tried again until it lands. One it refuses outright, such as a wrong token, is not tried again, and Vector’s log says so.
- Each request reaches Toposcope as the app sent it, so the limits are the ones a direct export meets: 1 MB, and 1,024 log records or spans.
- Metrics pass through too. A restart of Toposcope still costs a series that was already running the one interval described under [Running totals and deltas](ingest.md#running-totals-and-deltas).
- Vector listens on `127.0.0.1`. Whatever reaches those two ports is forwarded with the ingest token, so open them only to hosts you trust.

### Host metrics

The same file sends the health of the machine Vector runs on, every 15 seconds, through [Prometheus remote write](ingest.md#prometheus-remote-write) on a disk buffer of its own: CPU, memory and swap, load, disks, filesystems and network. Every series carries `host`, the machine's hostname, so one panel splits by machine. The names start with `host_`:

| Name | Kind | Labels |
| --- | --- | --- |
| `host_cpu_seconds_total` | counter | `cpu`, `mode` |
| `host_memory_used_bytes`, `host_memory_available_bytes`, `host_memory_total_bytes`, `host_memory_swap_used_bytes` | gauge | |
| `host_load1`, `host_load5`, `host_load15` | gauge | |
| `host_filesystem_used_bytes`, `host_filesystem_used_ratio`, `host_filesystem_total_bytes` | gauge | `device`, `filesystem`, `mountpoint` |
| `host_disk_read_bytes_total`, `host_disk_written_bytes_total` | counter | `device` |
| `host_network_receive_bytes_total`, `host_network_transmit_bytes_total` | counter | `device` |

To leave it out, delete the `machine` source and take it out of the `toposcope_prometheus` inputs.

### Run Vector in a container

Vector in a container reads the container, not the machine, unless it is given the machine's `/proc`, `/sys` and hostname. This runs it with all three:

```bash
docker run -d --name vector --restart unless-stopped --network host \
  --hostname "$(hostname)" \
  -v /proc:/host/proc:ro -v /sys:/host/sys:ro -e PROCFS_ROOT=/host/proc -e SYSFS_ROOT=/host/sys \
  -v "$PWD/vector.yaml":/etc/vector/vector.yaml:ro -v vector-data:/var/lib/vector \
  -e TOPOSCOPE_INGEST_TOKEN -e VECTOR_DATA_DIR=/var/lib/vector \
  timberio/vector:0.51.1-alpine
```

### Scrape a /metrics page

Postgres, Redis and nginx exporters, node_exporter and most Go services only offer a `/metrics` page. The file has a `prometheus_scrape` source for them, commented out.

1. Uncomment the `exporters` source.
2. List the pages under `endpoints`. This lists a Postgres and a Redis exporter, scraped every 15 seconds:

```yaml
  exporters:
    type: prometheus_scrape
    endpoints:
      - http://127.0.0.1:9187/metrics     # postgres_exporter
      - http://127.0.0.1:9121/metrics     # redis_exporter
    scrape_interval_secs: 15
    instance_tag: instance
```

3. Add `exporters` to the `toposcope_prometheus` inputs.

A page's address becomes the series' `instance`, and its host part `host`. Names keep the page's spelling, in lower case, and are read as [remote write](ingest.md#how-remote-write-series-are-stored) reads them: `_total` a counter, `_bucket` a histogram, the rest a gauge. A team that already runs Prometheus does not need this: point Prometheus at Toposcope with `remote_write` instead.

## Fluent Bit

This output sends Fluent Bit's logs and traces to Toposcope over OTLP HTTP, with the ingest token:

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

Alloy’s `otelcol.exporter.otlphttp` posts traces to `{endpoint}/v1/traces` and profiles to `{endpoint}/v1/profiles` on the same client. OTLP HTTP uses protobuf by default; JSON still works. This exporter sends to Toposcope with the ingest token:

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

`q` and Top-N only see stored keys. If a field must be searchable or appear in Top-N, the collector must write it as a top-level string attr before ingest. Existing rows are not rewritten.

### Operations a collector can run

| Operation | What it does |
| --- | --- |
| alias / copy | rename or duplicate a key |
| combine | turn N keys into one stored key |
| bucket | reduce cardinality so Top-N is not unique-per-event |
| local lookup | map a local file such as MMDB or CSV to one top-level key |

- Match on `service` and/or required-key existence, so every event does not run every rule.
- Nested objects become one JSON blob and are not dotted `q` paths.
- Extra keys count toward the 50-key cap.
- A detail-panel lookup does not satisfy `q` or Top-N.

### What ingest does without a collector

- Direct ingest without a collector does not grow collector-style derived keys (alias, combine, bucket, lookup).
- Exception attrs come from the app, OpenTelemetry, or collector enrichment. Ingest uses supplied frames or known `exception.stacktrace` formats and writes `e1`; see [Exception fingerprints](ingest.md#exception-fingerprints).
- OpenTelemetry `service.version` is aliased onto the attr `version` when `version` is unset. The dotted key is dropped, and a sender's `version` wins.
- `customer` and `flag` are not inferred. Copy them at the collector, as below, so the hunt can pin them as promoted columns.

### Copy customer and flag

This Vector remap copies `customer_id` to `customer` and `feature_flag` to `flag`. Run it before the sink:

```yaml
if exists(.customer_id) && !exists(.customer) {
  .customer = .customer_id
}
if exists(.feature_flag) && !exists(.flag) {
  .flag = .feature_flag
}
```

### Worked example

An event before enrichment:

```json
{"service":"api","level":"info","message":"ok","attrs":{"lat":51.5074,"lng":-0.1278,"client_ip":"8.8.8.8","user_id":"42"}}
```

The same event after the collector has added `usr`, `latlng` and `country` and rounded the coordinates:

```json
{"service":"api","level":"info","message":"ok","attrs":{"lat":"51.51","lng":"-0.13","latlng":"51.51,-0.13","client_ip":"8.8.8.8","user_id":"42","usr":"42","country":"US"}}
```

Then `usr:42`, `country:US`, and Top-N on `latlng` work.

### Vector enrichment

This example uses `remap` plus a local GeoLite / GeoIP MMDB to add `usr`, `latlng`, a rounded `duration_ms` and `country`. Run it before the `toposcope` sink; the sink input becomes `[enrich]`.

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

Alloy uses the same four operations. Round `lat` and `lng` before the concat because OTTL has no `round`; otherwise Top-N on `latlng` stays unique per event. This transform adds `usr`, `latlng`, an integer `duration_ms` and `country` for the `api` service:

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

## Related documentation

- [Ingest](ingest.md)
- [What an investigation reads](evidence.md)
- [Query language](query.md)
- [Operations](operations.md)
