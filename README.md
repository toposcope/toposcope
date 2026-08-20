# toposcope

Self-hosted log manager (`0.3.14`). Auth is required except `GET /api/health` and `GET /api/metrics`. There is no default password or ingest token. License: [LICENSE](LICENSE) (`Copyright (c) 2026 Vertixer Ltd.`). How to send a change: [CONTRIBUTING.md](CONTRIBUTING.md).

Toposcope is a single-node deployment—one app instance plus one ClickHouse—and does not provide high availability.

## Install (packaged)

Docker plus a generated `.env`. First searchable event in under 15 minutes. Do not clone the repo if you have the GitHub release files (`compose.yml`, `env.example`, `vector.yaml`, `LICENSE`). GitHub cannot ship a leading-dot `.env.example` (it becomes `default.env.example`); the release asset is `env.example`.

```bash
cp env.example .env
openssl rand -base64 32   # paste into CLICKHOUSE_PASSWORD, TOPOSCOPE_PASSWORD, TOPOSCOPE_INGEST_TOKEN
docker compose up -d
```

Wait until `http://127.0.0.1:8080/api/health` returns `ok`. Then Vector (0.51+):

```bash
set -a && source .env && set +a
vector -c vector.yaml
```

Open http://127.0.0.1:8080 (HTTP basic: any username, password from `TOPOSCOPE_PASSWORD`). Search `service:smoke`. Save. Alerts → Test on that saved search.

Image pin is `ghcr.io/toposcope/toposcope:0.3.14` (not `:latest`). Anonymous pulls need no registry login. ClickHouse stays on the Docker network (not published). App is `127.0.0.1:8080`. `bun run load:10m` needs `compose.dev.yml` limits, not this file.

## TLS

Terminate TLS on a reverse proxy you already run (Caddy, nginx, or Traefik on the host). Proxy to `http://127.0.0.1:8080` and pass `Authorization`. Do not add a proxy container to Toposcope’s Compose. Do not publish `0.0.0.0:8080`.

Caddy example:

```
toposcope.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

## Develop (Vite HMR)

ClickHouse in Docker via `compose.dev.yml`. API and UI on the host so UI edits hot-reload.

```bash
cp .env.example .env
docker compose -f compose.dev.yml up -d clickhouse
bun run dev
```

`bun run dev` may fill localhost demo secrets so HMR is not a secret-generation ritual. Packaged compose and the release image refuse those values.

ClickHouse is `26.3` (LTS). If an old `24.8` volume fails to start, recreate it (`docker compose -f compose.dev.yml down` + remove the `ch_data` volume in dev). First API boot materializes `idx_message_text` on existing parts.

Open http://127.0.0.1:5173 (basic auth: any username, password from `TOPOSCOPE_PASSWORD`). API is `127.0.0.1:8080`. Syslog UDP is `127.0.0.1:5514`.

Copy the URL to share a search (`q`, `range`, `live`, histogram `split`/`chart`/`scale`). `/` focuses search; arrow keys follow focus (rows, plot, facets, workspace tabs); Esc closes. Workspace tabs keep last results when you switch. Table times follow the histogram (date when the window needs it); Settings can switch to full. Click a level/service/host facet in the sidebar (or `+` on a field in the detail panel) to add it to the search bar. The histogram splits by level, service, host, or none; switch stacked / grouped / line and Linear / Log. Drag pans; Shift+drag selects a range; click the head strip above the plot to drill. Save / Save as in the search bar. Alerts is its own view (`?view=alerts`). Settings and ingest tokens are in the header.

## Ingest

Canonical path is Vector → `POST /v1/logs` OTLP protobuf. See [vector.yaml](vector.yaml). Fluent Bit, Alloy, curl, and syslog still work; they are not the 15-minute path.

JSON / NDJSON:

```bash
curl -u "toposcope:${TOPOSCOPE_PASSWORD}" -X POST http://127.0.0.1:8080/api/ingest \
  -H 'content-type: application/x-ndjson' \
  --data-binary '{"service":"api","level":"error","message":"timeout"}'
```

OTLP JSON (collectors: `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:8080`):

```bash
curl -X POST http://127.0.0.1:8080/v1/logs \
  -H "authorization: Bearer ${TOPOSCOPE_INGEST_TOKEN}" \
  -H 'content-type: application/json' \
  -d '{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"api"}}]},"scopeLogs":[{"logRecords":[{"severityText":"ERROR","body":{"stringValue":"timeout"}}]}]}]}'
```

OTLP protobuf (Vector / Fluent Bit / Alloy default). Same path; `Content-Type: application/x-protobuf`.

Metrics (same bearer token as logs; not Prometheus scrape — that stays `GET /api/metrics`):

```bash
curl -X POST http://127.0.0.1:8080/v1/metrics \
  -H "authorization: Bearer ${TOPOSCOPE_INGEST_TOKEN}" \
  -H 'content-type: application/json' \
  -d '{"name":"cpu_seconds","value":0.42,"labels":{"service":"api"}}'
```

Overlay on Search with `metric=cpu_seconds` (optional `ml=service:api`). Log `q` does not filter that series.

OTLP traces (same bearer token; collector samples — Toposcope stores what arrives):

```bash
curl -X POST http://127.0.0.1:8080/v1/traces \
  -H "authorization: Bearer ${TOPOSCOPE_INGEST_TOKEN}" \
  -H 'content-type: application/json' \
  -d '{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"nginx"}}]},"scopeSpans":[{"spans":[{"traceId":"aabbccddeeff00112233445566778899","spanId":"1122334455667788","name":"GET /","startTimeUnixNano":"1692000000000000000","endTimeUnixNano":"1692000000412000000","status":{"code":1}}]}]}]}'
```

A log with a 32-hex `trace_id` (or the same shape on `request_id` / `traceid` / `req_id`) gets **View trace** in the detail footer. A `request_id` like `req-…` is Follow only. Protobuf uses the same path (`Content-Type: application/x-protobuf`).

OTLP profiles (same bearer; Alpha at the collector — store what arrives, join only samples with a `trace_id` + `span_id` Link):

```bash
curl -X POST http://127.0.0.1:8080/v1/profiles \
  -H "authorization: Bearer ${TOPOSCOPE_INGEST_TOKEN}" \
  -H 'content-type: application/x-protobuf' \
  --data-binary @profile.pb
```

A selected waterfall span gets **View profiles**. `/v1development/profiles` is an alias. No `/debug/pprof` scrape.

Canonical smoke is [vector.yaml](vector.yaml). Production sink (0.51+, `otlp` codec):

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

Fluent Bit:

```
[OUTPUT]
    Name                 opentelemetry
    Match                *
    Host                 127.0.0.1
    Port                 8080
    Logs_uri             /v1/logs
    Traces_uri           /v1/traces
    Header               Authorization Bearer ${TOPOSCOPE_INGEST_TOKEN}
```

Alloy:

```
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

`http/protobuf` is the default OTLP HTTP encoding. JSON still works. Alloy's `otelcol.exporter.otlphttp` posts traces to `{endpoint}/v1/traces` and profiles to `{endpoint}/v1/profiles` on the same client. Ingest returns 429 when ClickHouse is busy. Sampling stays at the collector. Profiles are still Alpha there — store what arrives; join only samples with a `trace_id` + `span_id` Link.

### Enrich at the collector

`q`, Top-N, and rollups only see **stored** keys. If a field must be searchable or Top-N’d, the collector writes it as a **top-level** string attr before ingest. Four operations (any key names):

- **alias / copy** — rename or duplicate a key
- **combine** — N keys → one stored key
- **bucket** — reduce cardinality (round, geohash, truncate, lowercase) so Top-N is not unique-per-event
- **local lookup** — collector file (MMDB, CSV, …) → one top-level key; not HTTP per event

Match on `service` and/or required-key existence so not every message runs every rule. A nested object becomes one JSON blob and is not a dotted `q` path. Extra keys count toward the 50-key cap. A detail-panel lookup does not satisfy `q` or Top-N.

`POST /api/ingest` and `POST /v1/logs` without a collector do not grow derived keys. Toposcope has no rule engine, user JS, per-event HTTP, query-time derivation, ClickHouse dictionary, or Datasets UI. Fluent Bit is the same idea (modify / lua / geoip filter) — Vector and Alloy are the worked examples. This repo does not run those collectors.

Worked example (alias `usr`, rounded combine `latlng`, bucket `duration_ms`, MMDB → `country`). Before (direct ingest):

```json
{"service":"api","level":"info","message":"ok","attrs":{"lat":51.5074,"lng":-0.1278,"client_ip":"8.8.8.8","user_id":"42"}}
```

After the collector (what Toposcope should receive):

```json
{"service":"api","level":"info","message":"ok","attrs":{"lat":"51.51","lng":"-0.13","latlng":"51.51,-0.13","client_ip":"8.8.8.8","user_id":"42","usr":"42","country":"US"}}
```

Then `usr:42`, `country:US`, and Top-N on `latlng` work. Same pattern for any other stored key.

Vector (`remap` + a local GeoLite/GeoIP MMDB). Run this **before** the `toposcope` sink; `inputs` on the sink become `[enrich]`:

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

Alloy (`otelcol.processor.transform`). Same four operations; local lookup is a collector MMDB/CSV step, then copy a **top-level** key (do not leave a nested object). `Int` buckets `duration_ms` to whole milliseconds:

```
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

Round `lat`/`lng` before the Alloy concat (OTTL has no `round`); otherwise Top-N on `latlng` stays unique per event.

Syslog RFC 3164:

```bash
echo '<27>Aug 14 01:02:03 api-1 nginx: timeout' | nc -u -w1 127.0.0.1 5514
```

Create an extra ingest token (shown once):

```bash
curl -u "toposcope:${TOPOSCOPE_PASSWORD}" -X POST http://127.0.0.1:8080/api/api-tokens \
  -H 'content-type: application/json' \
  -d '{"name":"vector"}'
```

Search bar examples: `level:error`, `service:api timeout`. Time range: `15m`, `1h`, `4h`, `24h`, `7d`, `30d`, or any `\d+(ms|s|m|h|d|w)` up to 365 days, or custom From/To. Histogram bars auto-size (about 50–200, including `7d` on a year); chips pin `1ms`…`7d`. Wheel zooms the window. Live keeps that window ending now. See [docs/query.md](docs/query.md).

Optional seed (~200 events):

```bash
bun run seed
```

Empty ClickHouse logs, metrics, and spans (not SQLite) before a load run:

```bash
bun run truncate
```

Checks:

```bash
bun test
bun run e2e
bun run load          # 10k over 1h via mixed ingest paths; search under 1s
bun run load:500k     # 500k over 24h
bun run load:10m      # 10M over 7d through mixed ingest (slow, grows ClickHouse)
bun run load:100m     # 100M over 7d inside ClickHouse (a few GB)
bun run load:live     # constant rates until Ctrl-C (logs / metrics / traces)
```

Needs a running API (`bun run dev` or packaged). `LOAD_PROFILE` is an alias for the argument. Paired profiles, not a 3×3 matrix: MV queries stay near 1s; message/facet scans get a looser budget at 500k/10m. HTTP profiles mix JSON, NDJSON, OTLP JSON, OTLP protobuf, and a few syslog UDP batches; search must find every marker. `100m` skips those scans and does not go through ingest. Toolbar range includes `7d` for the 10m/100m windows. `LOAD_CHUNK` (default 5e6) and `LOAD_SKIP_DISK_CHECK=1` apply to `100m`.

`bun run load:live --logs=20 --metrics=2 --traces=1` keeps POSTing until SIGINT (`--for=12s` for a smoke). `0` turns a signal off. No client rate cap; POSTs pipeline (24 in-flight) and chunk to ingest 500 / 1MB. ClickHouse / ingest slots still bound what you actually land. Same `fake-event` mix; about 1/8 of logs carry a 32-hex `trace_id`, and most of those join a posted tree (a slice stay sampled-out). `request_id: req-…` and `client_ip` (region-weighted public IPv4; 40% hot hosts, 60% /16 tail) are on every fake log. Not a Toposcope ingest daemon.

## Upgrade notes

Boot is idempotent. No volume wipe.

- ClickHouse: `logs_by_minute` (with `host`) and `logs_attr_values_by_minute` are created on boot; missing day partitions are backfilled from `logs` (a 100M volume is per-day, not one INSERT). Unused Pass-2 `attr_path` / `attr_status` / `attr_user_id` columns are dropped.
- SQLite: `api_tokens`, `settings`, and extra `alert_rules` columns (`silenced_until`, …) are added on boot.
- TTL follows `PUT /api/settings` `{ "retention_days": 30 }` (1–365). Always `TTL toDate(ts) + INTERVAL n DAY`, never `TTL ts + …`. The `ALTER` does not wait for `MATERIALIZE TTL` (`alter_sync = 0`); SQLite is written first.
- New ports: syslog UDP `127.0.0.1:5514`. OTLP JSON and protobuf on the existing HTTP port (`POST /v1/logs`, `POST /v1/traces`, `POST /v1/profiles`). Metric points on `POST /v1/metrics` (same port and ingest token). `spans` and `profile_samples` are created on boot.
- `GET /api/metrics` is Prometheus text, unauthenticated (localhost-bound).

## Backup

Stop the stack, then copy **both** volumes (ClickHouse `ch_data` and SQLite `app_data`). Local `bun run dev` SQLite is `./data/toposcope.sqlite` instead of `app_data`.

```bash
docker compose down
docker run --rm -v toposcope_ch_data:/data -v "$(pwd)":/backup alpine \
  tar czf /backup/ch_data.tgz -C /data .
docker run --rm -v toposcope_app_data:/data -v "$(pwd)":/backup alpine \
  tar czf /backup/app_data.tgz -C /data .
```

Restore onto empty volumes (same compose project name so the volume names match):

```bash
docker compose down
docker volume create toposcope_ch_data
docker volume create toposcope_app_data
docker run --rm -v toposcope_ch_data:/data -v "$(pwd)":/backup alpine \
  tar xzf /backup/ch_data.tgz -C /data
docker run --rm -v toposcope_app_data:/data -v "$(pwd)":/backup alpine \
  tar xzf /backup/app_data.tgz -C /data
docker compose up -d
```

Compose may warn that `toposcope_ch_data` already exists and was not created by Compose. That is the restore. Do not set `external: true` on packaged `compose.yml`.

To roll back a packaged install, pin a previous published image tag in `compose.yml` and `docker compose up -d`. `0.3.14` is the first public pin, so there is no earlier public tag or image yet. SQLite migrations are add-column; extra columns on a downgrade are unused, not a wipe. A 24.8 → 26.3 ClickHouse data dir that refuses to start needs a restore, not a tag pin.

Measured numeric-scan envelope (100m/7d local): 24h `timeout` p99 ≈ 3.2M rows / 50MB / 0.1s; 7d ≈ 92M / 1.4GB / 1–7s. The live budget is 20M rows / 256MB / 8s (`src/query/agg.ts`). `bun run load:live --for=30s` at CLI 20/2/1 held ~20 logs/s, 2 metrics/s, 1 tree/s (600 logs / 60 metrics / 90 spans).

Restore drill (`compose.dev.yml` ClickHouse): `toposcope_ch_data` ~695MB → 389MB tgz, wipe, restore. 7d search total 1,101,088 before and after. SQLite on that host is `./data/toposcope.sqlite`, not `app_data`.

## Layout

- `compose.yml` — production: ClickHouse + pinned app image
- `LICENSE` — MIT Expat (`ee/` reserved if that tree exists)
- `compose.dev.yml` — local ClickHouse for `bun run dev` / load lab
- `vector.yaml` — canonical collector smoke
- `src/ingest` — JSON ingest, OTLP JSON/protobuf, syslog UDP
- `src/query` — search compiler + relative range + histogram MV
- `src/control` — SQLite, saved searches, tokens, alerts, settings
- `src/alerts` — in-process cron + webhook
- `src/ui` — Vite + React + shadcn/Tailwind operator UI
- `docs/ARCHITECTURE.md` — how it works
- `CHANGELOG.md` — shipped versions
- `CONTRIBUTING.md` — issues, PRs, local dev
- `scripts/load.ts` — burst smoke (`bun run load`) and continuous `load:live` (`100m` fills ClickHouse directly)
- `scripts/truncate.ts` — empty `logs`, `metrics`, `spans`, and minute rollups (`bun run truncate`)
