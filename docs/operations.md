# Operations

Toposcope is a single-node deployment: one app instance plus one ClickHouse. It does not provide high availability.

Auth is required except `GET /api/health` and `GET /api/metrics`. There is no default password or ingest token. `TOPOSCOPE_PASSWORD` is a shared operator credential with write access, including retention changes; there is no read-only role.

The packaged image is pinned to `ghcr.io/toposcope/toposcope:0.4.10` and should not be replaced with `:latest`. Images from 0.4.11 are published for `linux/amd64` and `linux/arm64`. 0.4.10 and earlier are amd64 only: on an arm64 host Docker will not pull one unless the `app` service names `platform: linux/amd64`, and it then runs emulated.

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

## Runtime ports and network

- App: `127.0.0.1:8080`
- ClickHouse: stays on the Docker network and is not published
- Syslog UDP: `127.0.0.1:5514`
- OTLP JSON and protobuf: the existing HTTP port on `/v1/logs`, `/v1/traces`, and `/v1/profiles`
- Metric points: `POST /v1/metrics` on the same port and ingest token
- Change marks: `POST /v1/marks` on the same port and ingest token; `GET /api/marks` lists them. Search / Follow draw them on the hunt histogram. GitHub Actions and GitLab CI samples in the [ingest guide](ingest.md) POST a deploy mark on release with a stable `id`.
- Probes: `POST /v1/probes` on the same port and ingest token; `GET /api/probes` lists `up` samples. Hunt overlays `metric=up`. A failed pull stores `up=0`. GitHub Actions sample in the [ingest guide](ingest.md).
- `GET /api/metrics`: Prometheus text, unauthenticated

## Upgrade and retention

Boot is idempotent. No volume wipe is required for a normal upgrade. The process listens on `:8080` before migrate; `/api/health` is **503** with `phase` (`starting` / `schema` / `repair` / `ready`) until ingest and search are safe, then **200**. Packaged Compose healthchecks that URL.

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

`0.3.14` is the first public pin. Pin `0.4.9` to roll back application code from `0.4.10`.

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
