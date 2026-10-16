# Operations

Toposcope is a single-node deployment: one app instance plus one ClickHouse. It does not provide high availability.

Auth is required except `GET /api/health` and `GET /api/metrics`. There is no default password or ingest token. `TOPOSCOPE_PASSWORD` is a shared operator credential with write access, including retention changes; there is no read-only role.

The packaged image is pinned to `ghcr.io/toposcope/toposcope:0.5.3` and should not be replaced with `:latest`. Images from 0.4.11 are published for `linux/amd64` and `linux/arm64`. 0.4.10 and earlier are amd64 only: on an arm64 host Docker will not pull one unless the `app` service names `platform: linux/amd64`, and it then runs emulated.

For the initial deployment and first searchable event, follow the [README quick start](../README.md#quick-start). This guide covers the ongoing operation of that packaged stack.

## TLS

Terminate TLS on a reverse proxy you already run, such as Caddy, nginx, or Traefik on the host.

Proxy to `http://127.0.0.1:8080` and pass `Authorization`. The packaged Compose file does not include a reverse proxy and keeps the application bound to loopback; do not publish it on `0.0.0.0:8080`.

Example:

```text
toposcope.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

OTLP over gRPC is a second listener, on `127.0.0.1:4319`, speaking HTTP/2 without TLS. An exporter that sends gRPC to an `https://` address needs the proxy to terminate TLS and pass HTTP/2 through to it, on a name or a port of its own:

```text
otlp.toposcope.example.com {
  reverse_proxy h2c://127.0.0.1:4319
}
```

In nginx that is `grpc_pass grpc://127.0.0.1:4319;` in a `server` block that listens with `http2 on;`.

Set `TOPOSCOPE_PUBLIC_URL` in `.env` to the address people open, such as `https://toposcope.example.com`, so an alert's webhook can link back to the search that fired. Toposcope cannot work it out itself: alerts are sent from a timer, and behind a proxy or a tunnel the address it listens on is not the one people open. Leave it unset and alerts carry no link. A path is kept, for a proxy that serves Toposcope under a prefix; a value that is not an `http` or `https` address, or that has a query or a `#`, stops the app at boot with that reason.

## Alert bodies

An alert sends its default body unless it is given one of its own in the alert dialog, under **Body**: **Text** (sent as `text/plain`) or **JSON** (sent as `application/json`). The default is the JSON Toposcope always sent, or a Slack message for a `hooks.slack.com` address.

A body is written with fill-ins, listed beside it in the dialog: `{{alert.name}}`, `{{series}}`, `{{value}}`, `{{threshold}}`, `{{query}}`, `{{fired_at}}` and `{{link}}` for a threshold alert; `{{alert.name}}`, `{{query}}`, `{{mark.kind}}`, `{{mark.version}}`, `{{mark.at}}`, `{{fingerprints.count}}`, `{{fingerprints.first}}`, `{{fingerprints}}`, `{{more}}` and `{{link}}` for a new-fingerprints one. `{{link}}` is empty unless `TOPOSCOPE_PUBLIC_URL` is set. In a JSON body every fill-in is a string, escaped to sit inside quotes, so it goes between `"…"`; a body that does not parse is refused with its line and column. **Send a test call** sends the body now, filled in from the last evaluation (or the last mark the alert watched), and shows the status, the time and the reply's first 200 characters.

A body is kept as the webhook address is, in SQLite, and anyone with the operator password can read it in the dialog; the Alerts list does not print it.

Pushover takes JSON with its own fields, at `https://api.pushover.net/1/messages.json`:

```json
{
  "token": "[YOUR APP TOKEN]",
  "user": "[YOUR USER KEY]",
  "title": "{{alert.name}}",
  "message": "{{fingerprints.count}} new after {{mark.kind}} {{mark.version}}: {{fingerprints.first}}",
  "url": "{{link}}",
  "url_title": "Open in Toposcope"
}
```

ntfy takes the body as the notification, at `https://ntfy.sh/<topic>`, so a text body is enough:

```text
{{alert.name}}: {{fingerprints.count}} new after {{mark.kind}} {{mark.version}}
{{fingerprints}}
{{more}}
{{link}}
```

## Runtime ports and network

- App: `127.0.0.1:8080`
- ClickHouse: stays on the Docker network and is not published
- Syslog UDP: `127.0.0.1:5514`
- OTLP over gRPC: `127.0.0.1:4319` (`OTLP_GRPC_PORT`; `0` turns it off), for logs, traces, metrics and profiles, with the same ingest token
- OTLP JSON and protobuf: the existing HTTP port on `/v1/logs`, `/v1/traces`, and `/v1/profiles`
- Metric points: `POST /v1/metrics` on the same port and ingest token
- Change marks: `POST /v1/marks` on the same port and ingest token; `GET /api/marks` lists them. Search / Follow draw them on the hunt histogram. GitHub Actions and GitLab CI samples in the [ingest guide](ingest.md) POST a deploy mark on release with a stable `id`.
- Probes: `POST /v1/probes` on the same port and ingest token; `GET /api/probes` lists `up` samples. Hunt overlays `metric=up`. A failed pull stores `up=0`. GitHub Actions sample in the [ingest guide](ingest.md).
- `GET /api/metrics`: Prometheus text, unauthenticated

## Memory

An instance that is doing nothing still takes memory, and almost all of it is ClickHouse: it fills its own caches and system tables whether or not anything arrives, then levels off. Plan for about 2 GB for an idle instance.

Measured with `docker stats` on an empty 0.4.10 instance, with no ingest and no searches:

| Minutes since ready | 0 | 5 | 10 | 15 | 20 | 30 | 40 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ClickHouse, GiB | 0.66 | 1.25 | 1.51 | 1.70 | 1.70 | 1.60 | 1.75 |

The app stayed near 30 MiB throughout. A second run, stopped at ten minutes, climbed more slowly: 0.25 GiB at ready and 0.71 GiB at ten minutes. Both ran arm64 images on Docker Desktop.

The packaged Compose file lets ClickHouse use up to 4 GB and the app up to 512 MB.

## Upgrade and retention

Boot is idempotent. No volume wipe is required for a normal upgrade. The process listens on `:8080` before migrate; `/api/health` is **503** with `phase` (`starting` / `schema` / `repair` / `ready`) until ingest and search are safe, then **200**. Packaged Compose healthchecks that URL.

On `docker compose stop`, an upgrade or a host shutdown the app finishes the requests in flight and the syslog queue, turns anything new away with **503**, and exits 0. Images up to 0.4.11 ignore the signal: Docker waits ten seconds and kills them, and a request that was still inserting is cut.

Update the application image pin in `compose.yml`, then pull and restart:

```bash
docker compose pull
docker compose up -d
```

`curl -fsS http://127.0.0.1:8080/api/health` prints `version`, so the new pin can be confirmed once it is up.

- ClickHouse tables such as `logs_by_minute` and `logs_attr_values_by_minute` are created on boot, and missing day partitions are backfilled from `logs`.
- SQLite adds new tables and columns on boot.
- Retention follows `PUT /api/settings` with `{ "retention_days": 30 }` and requires an integer from 1 to 365. Invalid values return **400** before any SQLite write or TTL change. A valid lower retention can delete older data as ClickHouse applies TTL.
- TTL is always `toDate(ts) + INTERVAL n DAY`, never `TTL ts + …`.
- The `ALTER` does not wait for `MATERIALIZE TTL` (`alter_sync = 0`), and SQLite is written first.
- `spans`, `profile_samples`, and `change_marks` are created on boot.

ClickHouse 26.3 is the supported LTS line. A too-old-server boot error selects `compose.yml` for a packaged install and `compose.dev.yml` for local development. Back up both stores before upgrading, then pull and restart ClickHouse with that Compose file. Do not remove the data volumes. If an older ClickHouse data directory refuses to start after a 24.8 → 26.3 migration, restore the data instead of pinning a different tag.

Version 0.4.9 changes fingerprint hash inputs for normalized paths and parsed stacks. Existing rows keep their stored ids, so affected errors can receive a new id once when upgraded. Later events use the corrected inputs; see [exception fingerprints](ingest.md#exception-fingerprints).

Version 0.4.11 does the same for three stack shapes: a Python traceback deeper than 50 frames, a Node `at async <path>` frame, and a PHP closure frame named with its file and line. Errors with one of those can receive a new id once when upgraded.

Version 0.5.0 answers an OTLP protobuf request in protobuf, as the protocol says; every reply was JSON before. A script that read `ingested` from the reply to a protobuf request has to send JSON instead. Boot adds one ClickHouse table, `metric_kinds`, which holds whether a metric name is a gauge or a counter. Rolling back to 0.4.12 leaves it in place and unused, and a counter then draws as an average again.

Version 0.5.2 publishes one more loopback port from the packaged `compose.yml`: `127.0.0.1:4319`, for OTLP over gRPC. The app container does not start if something on the host already has that port; change the host side of that mapping in `compose.yml`, or remove it. Boot adds two ClickHouse tables, `metric_buckets` and `metric_buckets_by_minute`, which hold histogram buckets. A histogram stored before the upgrade has no buckets, so its percentiles start with the first export afterwards; its count, sum and average read from the start. Rolling back to 0.5.1 leaves the tables in place and unused: a histogram is listed as its `.count` and `.sum` again, and a saved search or link that carries a reading (`metric=p99:…`) is refused there. `vector.yaml` now also listens for OTLP on ports 4317 and 4318 and keeps its buffers under `VECTOR_DATA_DIR`, so the quick start’s Vector step sets that directory and Vector keeps running after its three smoke events.

## Backup and restore

Stop the stack, then copy both volumes: ClickHouse `ch_data` and SQLite `app_data`.

```bash
docker compose down
docker run --rm -v toposcope_ch_data:/data -v "$(pwd)":/backup alpine \
  tar czf /backup/ch_data.tgz -C /data .
docker run --rm -v toposcope_app_data:/data -v "$(pwd)":/backup alpine \
  tar czf /backup/app_data.tgz -C /data .
```

Restore onto empty volumes with the same compose project name so the volume names match:

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

## Rollback

To roll back a packaged install, pin a previous published image tag in `compose.yml` and run `docker compose up -d`.

`0.3.14` is the first public pin. Pin `0.5.2` to roll back application code from `0.5.3`.

SQLite migrations are add-column. Extra columns on a downgrade are unused, not a wipe.

If a ClickHouse data directory from an older release refuses to start after the migration, use a restore rather than a tag pin.

## Health and metrics

`GET /api/health` and `GET /api/metrics` are open endpoints.

`GET /api/health` is **200** only when `phase` is `ready` and both stores ping; otherwise **503** with `phase`. Either way the body carries `version`, the running release — the same string as the image tag.

`GET /api/metrics` returns Prometheus text.

```bash
curl -fsS http://127.0.0.1:8080/api/health
curl -fsS http://127.0.0.1:8080/api/metrics
```
