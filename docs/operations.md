# Running Toposcope

This page is for whoever runs a packaged Toposcope install day to day: sign-in, TLS and the reverse proxy, ports, memory, ClickHouse's own logs, what Toposcope calls out to, retention, and health checks. Monitors, links and upgrades have [pages of their own](#other-pages).

Toposcope is a single-node deployment: one app instance plus one ClickHouse. It does not provide high availability.

For the initial deployment and first searchable event, follow the [README quick start](../README.md#quick-start). This guide covers the ongoing operation of that packaged stack.

## The image

The packaged image is pinned to `ghcr.io/toposcope/toposcope:0.15.7` and should not be replaced with `:latest`.

Images from 0.4.11 are published for `linux/amd64` and `linux/arm64`. 0.4.10 and earlier are amd64 only: on an arm64 host Docker will not pull one unless the `app` service names `platform: linux/amd64`, and it then runs emulated.

## Sign in

Auth is required except `GET /api/health` and `GET /api/metrics`. There is no shared password:

- people sign in as themselves, with one of three roles;
- scripts send a personal or service account token;
- machines that send logs use ingest tokens.

A browser signs in on a page that names the instance, so two instances are never confused. It signs in with an email and a password and then the six digits from an authenticator app, or with the provider when one is set up.

A new instance has no Owner until `./toposcope.sh owner-link <email>` on the host makes one. Forgot a password: an Owner resets your two-step, or sends a new invite. A locked-out Owner runs `owner-link` again.

[People and roles](people.md) covers the first Owner, invites, two-step, the provider and tokens.

## TLS

Terminate TLS on a reverse proxy you already run, such as Caddy, nginx, or Traefik on the host.

Proxy to `http://127.0.0.1:8080` and pass `Authorization`. The packaged Compose file does not include a reverse proxy and keeps the application bound to loopback; do not publish it on `0.0.0.0:8080`.

This Caddy site serves Toposcope at `toposcope.example.com`:

```text
toposcope.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

The proxy must also pass these through:

- `/ping/<key>`, the one route that takes no token, for [push monitors](monitors.md#push-monitors);
- `/link/v1/`, for [links](links.md#reaching-the-other-instance) from other instances.

### OTLP over gRPC behind the proxy

OTLP over gRPC is a second listener, on `127.0.0.1:4319`, speaking HTTP/2 without TLS. An exporter that sends gRPC to an `https://` address needs the proxy to terminate TLS and pass HTTP/2 through to it, on a name or a port of its own. In Caddy:

```text
otlp.toposcope.example.com {
  reverse_proxy h2c://127.0.0.1:4319
}
```

In nginx that is `grpc_pass grpc://127.0.0.1:4319;` in a `server` block that listens with `http2 on;`.

### Public address

Set `TOPOSCOPE_PUBLIC_URL` in `.env` to the address people open, such as `https://toposcope.example.com`. A monitor's webhook then links back to the search that opened it, and a link key carries this address.

Toposcope cannot work it out itself: calls are sent from a timer, and behind a proxy or a tunnel the address it listens on is not the one people open. Leave it unset and calls carry no link.

A path is kept, for a proxy that serves Toposcope under a prefix. A value that is not an `http` or `https` address, or that has a query or a `#`, stops the app at boot with that reason.

## Runtime ports and network

| What | Where | Notes |
| --- | --- | --- |
| App | `127.0.0.1:8080` | |
| ClickHouse | The Docker network only | Not published |
| Syslog UDP | `127.0.0.1:5514` | |
| OTLP over gRPC | `127.0.0.1:4319` | `OTLP_GRPC_PORT` moves it; `0` turns it off. Logs, traces, metrics and profiles, with the same ingest token |
| OTLP JSON and protobuf | The app's port: `/v1/logs`, `/v1/traces`, `/v1/profiles` | |
| Metric points | `POST /v1/metrics` on the app's port | Same ingest token |
| Change marks | `POST /v1/marks` on the app's port | Same ingest token. `GET /api/marks` lists them |
| Probes | `POST /v1/probes` on the app's port | Same ingest token. `GET /api/probes` lists `up` samples |
| Prometheus metrics | `GET /api/metrics` | Unauthenticated |

Search / Follow draw change marks on the hunt histogram. The GitHub Actions and GitLab CI samples in the [ingest guide](ingest.md#change-marks) POST a deploy mark on release with a stable `id`.

Hunt overlays probes as `metric=up`, and a failed pull stores `up=0`. There is a GitHub Actions sample in the [ingest guide](ingest.md#probes--liveness).

## Memory

Almost all of an instance's memory is ClickHouse; the app stays near 30 MiB. Out of the box ClickHouse is sized for a large shared server whatever it runs on: 512 scheduler threads, merge pools of 16, and caches of 5 to 8 GiB each.

So the packaged `compose.yml` starts it through a short script, the `clickhouse_size` config at its end. At every start it reads the CPUs and memory ClickHouse may use, and sizes it to them:

| Setting | Sized to |
| --- | --- |
| Memory budget | 80% of ClickHouse's container limit when `.env` sets one, else half of the machine's memory |
| Mark cache | An eighth of the budget |
| Primary index, index mark, uncompressed and text index postings caches | A sixteenth each |
| Text index token and header caches | A thirty-second each |
| Merge threads | As many as the CPUs, 2 to 16 |
| Scheduler threads | Four per CPU, 16 to 128 |
| Fetches, moves, distributed, message brokers | One each: a single node does not use them |

Past the budget ClickHouse refuses a query or an insert instead of being killed; ingest then answers 429 and senders retry.

### See and change the sizing

The script writes these to `/etc/clickhouse-server/config.d/toposcope-size.xml` inside the container, whose first line says what it found. This prints that line:

```bash
docker compose exec clickhouse head -1 /etc/clickhouse-server/config.d/toposcope-size.xml
```

There is no cap by default. To give ClickHouse less, set it in `.env` and run `docker compose up -d`; the budget follows:

```bash
CLICKHOUSE_MEMORY=2G
CLICKHOUSE_CPUS=2
```

On an empty instance (no ingest, no searches; ClickHouse 26.3 on Docker Desktop, arm64, 8 CPUs, 16 GB, no cap) ClickHouse used 128 MiB when ready and 177 MiB after 30 minutes, with 121 threads.

## ClickHouse's own logs

Out of the box ClickHouse logs at trace level and keeps a dozen system log tables with no end date. On a packaged install that was most of the data volume: `system.text_log` alone grew past 4 GiB, almost all of it trace and debug lines, beside 150 MiB of Toposcope's own data.

The packaged `compose.yml` gives ClickHouse a `config.d` file, the `clickhouse_logs` config at its end, which:

- logs warnings and up;
- turns off `text_log`, `trace_log`, `processors_profile_log`, `query_views_log`, `query_thread_log`, `query_metric_log`, `metric_log`, `asynchronous_metric_log`, `part_log`, `background_schedule_pool_log` and `opentelemetry_span_log`;
- keeps `query_log`, `error_log` and `asynchronous_insert_log` for 7 days.

Toposcope reads only `system.metrics`, `system.events`, `system.asynchronous_metrics` and `system.parts`, which this does not touch. To keep more, put your own file in `compose.override.yml` beside it. Compose configs with `content` need Docker Compose 2.23.1 or later.

### Drop the old log tables

On an install from before this, the tables ClickHouse wrote stay until they are dropped, and the kept ones are set aside as `query_log_0` and the like when their end date is added. After upgrading, this drops both; run it in the install's directory:

```bash
docker compose exec -T clickhouse sh -c 'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --format TSVRaw --queries-file /dev/stdin | clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --multiquery' <<'SQL'
SELECT 'DROP TABLE system.' || name || ' SYNC;' FROM system.tables
WHERE database = 'system' AND match(name, '^(text_log|trace_log|processors_profile_log|query_views_log|query_thread_log|query_metric_log|metric_log|asynchronous_metric_log|part_log|background_schedule_pool_log|opentelemetry_span_log)$|_log_[0-9]+$')
SQL
```

### Disk in the footer

The footer's ClickHouse chip shows memory, then `disk`: the whole filesystem ClickHouse is on, other files included. What ClickHouse itself stores, and how much of that is these logs, is in the chip's tooltip and in **Settings › Storage**.

## What Toposcope calls out to

Toposcope calls out only where this table says. Everything but the release check is something you set up.

| What | Calls | When |
| --- | --- | --- |
| [The release check](#the-release-check) | `api.github.com` | On by default: once a day, and a few minutes after start |
| Webhooks | Each monitor's own, and the default in Settings | When a monitor calls |
| HTTP(S), TCP and certificate monitors | The addresses and ports they check, from this node | On each run |
| Links | The instances this one pulls from or serves, as each link says | While a link runs |
| `TOPOSCOPE_WATCHDOG_URL` | The check-in URL | After each monitor pass, when it is set ([Who watches Toposcope](monitors.md#who-watches-toposcope)) |
| [GitHub, once an Owner connects it](#github-repositories) | `github.com`, `api.github.com` | While connecting, and when repositories are listed |

### The release check

Once a day, and a few minutes after it starts, the app reads GitHub's public list of releases: `GET https://api.github.com/repos/toposcope/toposcope/releases?per_page=30`, with `User-Agent: toposcope` and nothing else. It sends no version, no instance name, no address; GitHub sees the box's IP. A failed check is noted quietly and tried again the next day. It honours `HTTPS_PROXY`.

**Check now** in the footer's version popover, or signed-in `POST /api/version/check`, runs the same check at once, at most once every 30 seconds. It does not move the daily one. The footer shows what it found, and signed-in `GET /api/version` returns it.

Set `TOPOSCOPE_UPDATE_CHECK=off` in `.env` and restart to stop it; then nothing is called.

### Paging on a new release

The first time the check sees a version newer than the running one, Toposcope writes one row, `service:toposcope event:update_available`, with `running`, `latest`, `step` (`patch`, `minor` or `major`), `behind` and `url`. It writes one row per version, never again for the same one. To be paged:

1. Save a search for `service:toposcope event:update_available` over 1 day.
2. Give it a monitor that opens at **at least 1**, with reminders off.
3. Add `step:minor OR step:major` to the search to page only on the bigger steps.

A monitor with the default body sends a resolved call a day later, when the row leaves its window. Give it a body of its own with an empty resolved body to send none.

### GitHub repositories

Once an Owner connects GitHub on **Settings › Repositories**, Toposcope calls:

- `github.com/login/device/code` and `github.com/login/oauth/access_token` while a device code waits;
- `api.github.com/user/installations` and each installation's repositories when Repositories is open or Set lists them. A list is reused for 30 seconds.

The token is GitHub's and is kept in SQLite, never sent to a browser; it reads repository names and nothing else. Disconnect, or revoke the Toposcope App on GitHub, ends it. `TOPOSCOPE_GITHUB_CLIENT_ID` and `TOPOSCOPE_GITHUB_APP` (its slug) point the instance at a GitHub App of your own instead of Toposcope's.

## Retention

Retention is set with `PUT /api/settings`. A lower retention can delete older data as ClickHouse applies it.

| Setting | Example body | Range | Applies to |
| --- | --- | --- | --- |
| `retention_days` | `{ "retention_days": 30 }` | An integer from 1 to 365. Invalid values return **400** before anything is saved or any retention changes | Logs, spans, profiles and marks, and the two below while they are not set |
| `metrics_retention_days` | `{ "metrics_retention_days": 400 }` | 1 to 730; `null` puts metrics back on `retention_days` | Metric points, histogram buckets and their per-minute counts |
| `retention_rules` | `{ "retention_rules": [{ "service": "analytics", "days": 730 }] }` | At most 8 services, 1 to 730 days, never fewer than `retention_days`; `[]` puts every service back | That service's logs, their per-minute counts and its spans (**Kept longer** in Settings) |

### Keeping some data longer

Metrics can keep longer than logs. A year of metrics is small next to logs, and they carry no addresses, so a 30-day privacy line on logs can stay where it is.

A service can keep longer than logs too. Every other service keeps `retention_days`. A product event stream that carries no addresses can keep two years while the logs that carry them keep 30 days; send it under a service of its own.

## Health and metrics

`GET /api/health` and `GET /api/metrics` are open endpoints.

`GET /api/health` is **200** only when `phase` is `ready` and both stores ping; otherwise **503** with `phase`. Either way the body carries `version`, the running release: the same string as the image tag.

`GET /api/metrics` returns Prometheus text. `toposcope_syslog_dropped_total` is the syslog UDP rows that were not stored, by reason ([Syslog](ingest.md#syslog)).

These print the health and the metrics:

```bash
curl -fsS http://127.0.0.1:8080/api/health
curl -fsS http://127.0.0.1:8080/api/metrics
```

## Other pages

- [Monitors](monitors.md): monitors of every kind, their bodies, and who watches Toposcope.
- [Links](links.md): one instance pulling rows from another.
- [Upgrades, backups and rollback](upgrades.md): `upgrade.sh`, upgrading by hand, backups and going back.

The sections below moved to those pages.

## Monitors

Monitors have their own page: [Monitors](monitors.md).

## Monitor bodies

Moved to [Monitor bodies](monitors.md#monitor-bodies).

## Who watches Toposcope

Moved to [Who watches Toposcope](monitors.md#who-watches-toposcope).

## Links

Linking instances has its own page: [Links](links.md).

## Upgrade and retention

Upgrades have their own page: [Upgrades, backups and rollback](upgrades.md). Notes for each release up to 0.7.1 are in [Upgrade notes up to 0.7.1](upgrades.md#upgrade-notes-up-to-071); retention is under [Retention](#retention).

### Check a backup

Moved to [Check a backup](upgrades.md#check-a-backup).

### Upgrading from 0.9

Moved to [Upgrading from 0.9](upgrades.md#upgrading-from-09).

## Backup and restore

Moved to [Backup and restore](upgrades.md#backup-and-restore).

## Rollback

Moved to [Rollback](upgrades.md#rollback).
