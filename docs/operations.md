# Operations

Toposcope is a single-node deployment: one app instance plus one ClickHouse. It does not provide high availability.

Auth is required except `GET /api/health` and `GET /api/metrics`. There is no default password or ingest token. `TOPOSCOPE_PASSWORD` is a shared operator credential with write access, including retention changes; there is no read-only role.

The packaged image is pinned to `ghcr.io/toposcope/toposcope:0.5.7` and should not be replaced with `:latest`. Images from 0.4.11 are published for `linux/amd64` and `linux/arm64`. 0.4.10 and earlier are amd64 only: on an arm64 host Docker will not pull one unless the `app` service names `platform: linux/amd64`, and it then runs emulated.

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

Set `TOPOSCOPE_PUBLIC_URL` in `.env` to the address people open, such as `https://toposcope.example.com`, so a monitor's webhook can link back to the search that opened it. Toposcope cannot work it out itself: calls are sent from a timer, and behind a proxy or a tunnel the address it listens on is not the one people open. Leave it unset and calls carry no link. A path is kept, for a proxy that serves Toposcope under a prefix; a value that is not an `http` or `https` address, or that has a query or a `#`, stops the app at boot with that reason.

## Monitors

A monitor (**Watch → New monitor**, or **Watch this** on a saved search) reads its saved search every minute. At or above its threshold it **opens**: it calls its webhook once, then reminds while it stays open (every 4h by default; off, once per window, 1h or 24h), and when the search falls back it **resolves** and calls once more. A reading that is refused or fails changes nothing. Each open-to-resolved stretch is kept with the calls sent during it, and Watch draws them on one clock. Silence stops the calls, not the record. Alerts made before 0.6 are monitors that remind once per window, so they call as often as they did.

A **push monitor** takes results instead of reading a search: a cron job, a backup or a Nagios plugin says how it went, through `POST /v1/checks` with the ingest token or its keyed URL `/ping/<key>` with none, and a name not seen before creates it. It opens on a fail, or when no result has come for its `every` plus its grace, and the next ok resolves it; a warn shows on Watch and calls nobody. See [Check results](ingest.md#check-results-push-monitors).

**Settings → Default webhook** is called by any monitor without its own, such as one created by its first result. Leave it empty and such a monitor keeps its state and calls nobody.

`/ping/<key>` is the one route that takes no token, so a proxy in front of Toposcope must pass it through. Its key is printed only on the monitor's page and in its editor; anyone holding it can post that monitor's results and nothing else. Replace a leaked key by declaring the monitor again (`PUT /api/monitors/<name>` with `"source": "push"`, its `every` and `grace`, and a new random UUID as `key`), or delete and recreate it.

A script or an agent can declare one without the UI, by name; the same name replaces it:

```bash
curl -u op:"$TOPOSCOPE_PASSWORD" -X PUT http://127.0.0.1:8080/api/monitors/api-errors \
  -H 'content-type: application/json' \
  -d '{"source": "search", "saved_search": "api errors", "threshold": 50, "webhook_url": "https://ntfy.sh/my-topic", "remind_every": "4h"}'
```

## Monitor bodies

A monitor sends its default body unless it is given one of its own in the monitor dialog, under **Body**: **Text** (sent as `text/plain`) or **JSON** (sent as `application/json`). The default is the JSON Toposcope always sent, with `state` (`open`, `reminder` or `resolved`), `opened_at` and `resolved_at`, or a Slack message for a `hooks.slack.com` address that says when it resolved and how long it lasted.

A body is written with fill-ins, listed beside it in the dialog: `{{alert.name}}`, `{{series}}`, `{{value}}`, `{{threshold}}`, `{{query}}`, `{{fired_at}}`, `{{link}}`, `{{state}}`, `{{opened_at}}`, `{{resolved_at}}`, `{{duration}}` and `{{message}}` (the result that opened it) for a saved-search monitor; `{{alert.name}}`, `{{query}}`, `{{mark.kind}}`, `{{mark.version}}`, `{{mark.at}}`, `{{fingerprints.count}}`, `{{fingerprints.first}}`, `{{fingerprints}}`, `{{more}}` and `{{link}}` for a new-fingerprints one. `{{link}}` is empty unless `TOPOSCOPE_PUBLIC_URL` is set. In a JSON body every fill-in is a string, escaped to sit inside quotes, so it goes between `"…"`; a body that does not parse is refused with its line and column. A saved-search monitor with a body of its own sends a resolved call only when it is given a second body, **When it resolves**; left empty, it sends none, so a message written for “it opened” never arrives when it ended. **Send a test call** sends the body now, filled in from the last evaluation (or the last mark the monitor watched), then the resolved body when there is one, and shows the status, the time and the reply's first 200 characters.

A body is kept as the webhook address is, in SQLite, and anyone with the operator password can read it in the dialog; Watch does not print it.

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

## Links

A link is one instance pulling rows from another, made from **Links** in the header. The instance the other can reach mints a key; the other pastes it, and the side that pasted connects. **Offer rows from here** mints a single-use key for one filter: whoever pastes it pulls the rows that match. **Invite a source here** mints a key that lets this instance pull from whoever pastes it, once or for many until a date (30 days at most). A key carries this instance's address, its name, a short id, the filter and a secret; it is shown once and stored hashed. On the first paste the two instances swap it for a secret of their own, and that secret reads the link's feed and nothing else.

The address in a key is `TOPOSCOPE_PUBLIC_URL` when it is set, else the address the browser opened. The other instance has to reach `/link/v1/` there: behind a reverse proxy, forward it like the rest of the app. Those routes do not take the operator password; each proves a key's or a link's secret. The operator password never travels between instances.

The puller asks every 5 seconds for what arrived after where it stands, stores the rows as they were (the source's `e1`, its `toposcope` name) and keeps its position, so a restart of either side picks up where it stopped. A row is never stored twice, across retries, links with overlapping filters, or a row that left and came back. Pulled rows follow this instance's retention. Removing a link stops it and deletes nothing.

Change marks come with a link, so Fingerprints and Compare at the collecting instance have the source's deploys to cut against. A mark is not a log line, so a filter like `level:error` does not apply to it: a link brings every mark whose `service` its filter does not rule out by a plain mismatch. A pulled mark keeps its kind, service, title and attributes, and its id gains the instance it was posted at — `deploy-api-v1.4@edge-fra` — so two sources that both post `deploy-api-v1.4` stay two marks on the lane, each cutting its own window. An incident the source closes later closes here too. A pulled mark is not edited or deleted here, and nothing is written back to the source. Marks posted before 0.5.5 stay where they were posted.

The side that pasted connects. An invite is pasted by the source, so a source behind NAT — a customer site, a laptop — feeds a reachable instance with no inbound port: it calls out every 5 seconds, asks where the puller stands, reads its own rows from there and hands them over. It is still a pull: the puller keeps the position and the source's own store is the buffer, so a dropped connection resumes where it stopped. The list says who connects — “we call them” or “they call us” — and a quiet link reads “not answering since” or “has not called since” to match.

Search says what this instance holds. Once anything is linked, a **toposcope** group opens the sidebar, second only to a board's inputs or Surroundings' frozen scope: each source as named on its side, its count in the hunt, its filter word for word when it has one, and its position only when it is short — behind and read to when, not answering (or not called) since when, or a hole, closed at both ends. Ticking a source writes `toposcope:<name>` in the bar, as ticking a level does. Under 30 seconds behind reads as caught up. While a source is short inside the window, every count it could feed is a floor (`≥`): the strip with one pill naming the source, the table footer, the facets, Stat counts, Top-N bars and saved-search badges over their own spans. The plot hatches the span its rows are not here for, and the table has one hatched row at its read position. A count stays plain when the hunt names other sources (`toposcope:prod-us`), or when the short source's filter rules it out by a plain `key:value` mismatch. A percentile, rate or average keeps its number and says it is over what is here. When part of a count came through a link's filter that the hunt does not already imply, a grey scope beside it says so. An instance that pulls from no one shows none of this. Fingerprints and Compare judge across a gap with floors. While a source that could feed the hunt is short inside either window, the cut keeps its three sets, counted by source on both sides: a line no short source fed is judged as ever; a line also fed by a caught-up source is filed as its counts read, with the short side's count a floor and a note that it is partly from the short source; a line whose every row came from a short source reads `131 → ?` or `? → 64` and is filed as can't tell — never stopped, never first seen. The head note says where the source stands and which side misses its rows. The Compare fold keeps each short side as a floor and shows no delta and no percent. Both are frozen at open: close and reopen once the source has caught up. A new-fingerprints alert pages only what it can tell is new.

Both sides behind NAT is for the operator's VPN; Toposcope runs no relay.

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

Version 0.5.4 adds one ClickHouse table at boot, `metric_units`, which keeps the unit each metric name was last sent with. SQLite gains a `sessions` table for browser sign-ins, an `alert_sent_fingerprints` table, and new columns on alert rules (`kind`, `last_mark`, `body_kind`, `body_template`). A browser now gets a sign-in page instead of the password prompt. Its session lasts 30 days and ends on Sign out or when `TOPOSCOPE_PASSWORD` changes. Scripts and agents that send Basic auth or the ingest token are unchanged. `TOPOSCOPE_PUBLIC_URL` is optional and only adds links to alerts.

Rolling back to 0.5.3 leaves the new table and columns in place and unused: metric units are no longer shown, sign-in falls back to the browser's prompt, and the bare address opens a plain search instead of Home. 0.5.3 reads every alert rule as a threshold alert, so before rolling back, delete or silence new-fingerprints alerts. Otherwise each one pages whenever its saved search has at least its N events in the window. An alert with a body of its own goes back to the default body.

Version 0.5.5 adds links. Boot adds to `logs` the columns `seq` and `src_seq` (each with a minmax index), `toposcope`, `arrived` and `src_id`, and adds `toposcope` to the end of each minute rollup's key; it adds `seq` and `toposcope` to `change_marks`, and one ClickHouse table, `arrival_seq`, the counter that orders rows by arrival. The first feed read adds a projection ordered by arrival to `logs`. SQLite gains `feeds`, `link_keys` and `links`. Every row and rollup already stored is kept; rows stored before have no arrival position, so a link does not carry them. A link needs `/link/v1/` reachable at the address in its key: see “Links” above.

Rolling back to 0.5.4 leaves the new columns, table and projection in place and unused: links stop, Search draws no toposcope group, and rows already pulled stay as ordinary rows. 0.5.4 stores new rows without an arrival position or an instance name, so after rolling forward again a link does not carry rows stored in between.

Version 0.5.6 changes what panel titles, the Alerts list and Search draw, and nothing at boot: rolling back to 0.5.5 is the pin alone.

Version 0.5.7 adds one ClickHouse table at boot, `metric_descriptions`, which keeps the description each metric was sent with. Rolling back to 0.5.6 leaves it in place and unused, and descriptions are no longer shown. A panel there draws only its own metric: its merged lines, line names, title and note are not read, and a saved search saved again there loses them. A link made on 0.5.7 that carries them can open that panel with its Replace and log-scale switches wrong.

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

`0.3.14` is the first public pin. Pin `0.5.6` to roll back application code from `0.5.7`.

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
