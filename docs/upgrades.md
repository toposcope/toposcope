# Upgrades, backups and rollback

This page is for whoever runs a packaged Toposcope install: how to upgrade it with `upgrade.sh`, from the app or by hand, how to back it up and check the backup, and how to go back to an earlier release.

Upgrade with `upgrade.sh` when you can: it backs up first and goes back on its own when the new version does not come up. Every release from 0.6.1 on ships it.

## Upgrade with upgrade.sh

`upgrade.sh` is the operator's script for upgrading a packaged install. Run it on the host, in the directory that holds `compose.yml` and `.env`. It is not the agent skill's `toposcope.sh`: that one never removes data.

These upgrade to the latest stable release, to a given release, and to a given release without a backup:

```bash
./upgrade.sh                # to the latest stable release
./upgrade.sh 0.6.2          # to a given release
./upgrade.sh 0.6.2 --no-backup
```

### What upgrade.sh does

In order, it:

1. Checks that Toposcope answers as healthy. It refuses a release that is not newer than the running one.
2. Downloads the release's files into `releases/X.Y.Z/` and checks each against its `SHA256SUMS`. If one does not match, nothing else happens.
3. Prints each newer release's Before you upgrade.
4. Pulls the new image while the old one still runs.
5. Reads which volumes the stack's containers mount, checks the free disk, and stops the stack.
6. Backs up those volumes into `backups/<UTC time>-<from version>/`, with the `compose.yml` in use and their names in `volumes`. ClickHouse's own `system` database (its logs) is left out: ClickHouse makes it again when it starts.
7. Reads each archive back. One with no files, or with less than half the bytes its volume holds, stops the upgrade, starts the old version again and removes no older backup. It says where the backup went and how big it is, and keeps the last 2 that hold data.
8. Swaps `compose.yml`, keeping `.env` and `compose.override.yml`. An edited `vector.yaml` is kept, with the new one beside it as `vector.yaml.new`. Any setting the new `env.example` has that `.env` lacks is named.
9. Starts the stack and waits up to 10 minutes (`--wait <minutes>`) for `/api/health` to report the new version.
10. Posts a deploy change mark, `Toposcope 0.6.1 → 0.6.2`.
11. Removes the `ghcr.io/toposcope/toposcope` images that nothing here names: not the new release's, not the one it came from, not a kept backup's. Docker keeps any image a container still uses.

### While the stack is stopped

Ingest is refused while the stack is stopped. The packaged Vector buffers on disk and sends when the app is back. OTLP exporters retry or drop according to their own settings, and syslog over UDP is lost. Every run prints how long the stop lasted.

### When the new version does not come up

If the new version does not come up, `upgrade.sh` prints the app's last log lines, starts the old version with its own `compose.yml`, and marks that. If the old version will not open its data either, it restores both volumes from the backup first.

### Backup and rollback commands

| Command | What it does |
| --- | --- |
| `./upgrade.sh backup` | Takes the same backup on its own, then starts the stack again |
| `./upgrade.sh rollback --yes` | Goes back to the last backup: its `compose.yml` and both volumes. Everything stored since that backup is lost, so without `--yes` it only says which backup and when it was taken |

### When upgrade.sh stops early

If the containers cannot be found, `upgrade.sh` stops before anything is done. That happens, for example, when `COMPOSE_PROJECT_NAME` is set in the shell to a name the stack does not run under.

A backup that holds no data, such as one taken by 0.15.2 or earlier on the wrong volumes, is never counted among the 2 kept and never rolled back to. It is named on each run for you to delete.

## Check a backup

A backup is two archives of the volumes the stack mounts. To check one, compare what it holds with those volumes:

```bash
# The volumes the stack mounts, and the ones the backup was taken from (0.15.3 and later)
docker inspect -f '{{ range .Mounts }}{{ .Name }} {{ end }}' $(docker compose ps -aq)
cat backups/<backup>/volumes
# Every backup's size: one of a few KB is empty
du -sh backups/*/
# The app's archive holds toposcope.sqlite; ClickHouse's holds a file per table part, thousands on a busy install
tar tzf backups/<backup>/app_data.tgz | grep toposcope.sqlite
tar tzf backups/<backup>/ch_data.tgz | grep -vc '/$'
```

A backup of an install that has stored anything is never a few hundred bytes. `ch_data.check` and `app_data.check` beside the archives hold three numbers each: the bytes in the volume, the bytes in the archive and its file count.

## Upgrade from the app

From 0.6.3 the footer's version popover can upgrade too, once the host allows it. The app still never touches Docker: its **Upgrade** button only writes the release asked for into `upgrade/request.json` in the app's own volume, and the host runs `upgrade.sh`.

1. Turn it on once, as root, in the install's directory (Linux with systemd):

   ```bash
   sudo ./upgrade.sh enable-ui
   ```

2. Any Owner can then start an upgrade to a published release from the version popover. Rollback stays on the host.
3. To turn it off, run `sudo ./upgrade.sh disable-ui`, which removes both units.

### What enable-ui installs

`enable-ui` installs `toposcope-upgrade-<project>.path`, which watches the request file, and `toposcope-upgrade-<project>.service`, which runs `./upgrade.sh ui-run` here, as root.

`ui-run` takes the request first, accepts only a bare `X.Y.Z`, and runs `./upgrade.sh X.Y.Z` exactly as above, backup and way back included. It writes how it went to `upgrade/status.json` and the output to `upgrade/last.log`, both in the app's volume, and the popover shows them.

- Only a release the release check knows as newer can be asked for, one at a time.
- A request the host has not taken within 2 minutes is dropped.
- The volume is the app's to write, so `ui-run` never opens a path in it. Every read and write there runs in a throwaway container that mounts only that volume, with no network, so a link the app put there cannot name a host path.

## Upgrade by hand

No volume wipe is required for a normal upgrade.

1. Back up both stores ([Backup and restore](#backup-and-restore)).
2. Update the application image pin in `compose.yml`.
3. Pull the new image and restart. `--wait` returns once the app is healthy:

   ```bash
   docker compose pull
   docker compose up -d --wait
   ```

4. Confirm the new pin: `curl -fsS http://127.0.0.1:8080/api/health` prints `version`.

### What happens at boot

Boot is idempotent. The process listens on `:8080` before it migrates. `/api/health` is **503** with `phase` (`starting` / `schema` / `repair` / `ready`) until ingest and search are safe, then **200**. The packaged Compose file healthchecks that URL.

Boot creates the ClickHouse tables a release adds, backfills missing days of the per-minute counts from the stored logs, and adds new SQLite tables and columns. Retention is set from Settings ([Retention](operations.md#retention)).

### Stopping the app

On `docker compose stop`, an upgrade or a host shutdown, the app finishes the requests in flight and the syslog queue, turns anything new away with **503**, and exits 0. Images up to 0.4.11 ignore the signal: Docker waits ten seconds and kills them, and a request that was still inserting is cut.

### ClickHouse version

ClickHouse 26.3 is the supported LTS line. A too-old-server boot error names `compose.yml` for a packaged install and `compose.dev.yml` for local development.

1. Back up both stores.
2. Pull and restart ClickHouse with that Compose file. Do not remove the data volumes.
3. If an older ClickHouse data directory refuses to start after a 24.8 → 26.3 migration, restore the data instead of pinning a different tag.

## Upgrading from 0.9

0.10 carries every kind over a link, and links do not carry across the upgrade. No table or column is dropped; monitors made before 0.10 are removed.

1. Upgrade as usual, on both sides of each link. When 0.10 first starts it stops every link made before 0.10 (removed, as Revoke does, with its record kept), since those links cannot carry this release's data.
2. Once both sides run 0.10, make each link again: **Make a link key** on the side that mints, with its scope and kinds, and **Paste a link key** on the other. A `tsl1_` key is refused. A new link reads the source from its start; log rows pulled before are not stored twice.
3. Make each monitor again, naming its service. Monitors made before 0.10 name none, so each start removes every monitor with no service, with its stretches, calls and silences, and logs one line saying how many. Note the monitors you have in Watch before you upgrade.
4. Make every script that creates monitors over the API send `service` (`POST /api/alert-rules`, `PUT /api/monitors/:name`). A monitor saved without one answers 400, and a save that leaves it out of a monitor that has one keeps it.

### What is lost going to 0.10

- Monitors made before 0.10, with their stretches and calls. Their results are not read and age out with retention.
- Monitor results kept before 0.10 are not copied over, so Watch's strips start again at the upgrade. Stretches and calls are kept.
- Spans, metric points, histogram buckets and profile samples stored before 0.10 have no position and never travel over a link.
- A metric name's kind, unit and description come off its newest point that has one. A name not sent since the upgrade reads as a gauge, with no unit or description, until its next point.

A link costs disk on the source once it carries a kind: about 90 % more for spans and 130 % more for metrics, measured on synthetic data.

### Going back to 0.9.0

`./upgrade.sh rollback --yes` restores the backup it took before the upgrade, links and monitors made before 0.10 included, and loses what came in since.

Pinning 0.9.0 by hand ([Rollback](#rollback)) keeps the data: 0.9.0 runs on the new tables and columns and leaves them unread.

- Links stopped at the upgrade stay stopped, and monitors removed at the upgrade stay removed.
- Links made under 0.10 are not for 0.9: a `tsl2_` key cannot be pasted there, and a 0.10 side refuses a 0.9 one, so revoke them and make links again on 0.9.
- Monitor results written under 0.10 are not read by 0.9, so Watch's strips show a gap for that time.
- A metric name first sent under 0.10 has no kind or unit on 0.9 until it is sent again there, and a counter reads as an average meanwhile.
- Rows already pulled stay as ordinary rows.

## Backup and restore

A backup is a copy of both volumes: ClickHouse `ch_data` and SQLite `app_data`. `./upgrade.sh backup` does this for you, without ClickHouse's own logs.

The names below are for the compose project `toposcope`. This prints the ones your stack mounts: `docker inspect -f '{{ range .Mounts }}{{ .Name }} {{ end }}' $(docker compose ps -aq)`.

### Back up by hand

1. Stop the stack:

   ```bash
   docker compose down
   ```

2. Copy the ClickHouse volume into `ch_data.tgz` in the current directory:

   ```bash
   docker run --rm -v toposcope_ch_data:/data -v "$(pwd)":/backup alpine \
     tar czf /backup/ch_data.tgz -C /data .
   ```

3. Copy the SQLite volume into `app_data.tgz`:

   ```bash
   docker run --rm -v toposcope_app_data:/data -v "$(pwd)":/backup alpine \
     tar czf /backup/app_data.tgz -C /data .
   ```

### Restore

Restore onto empty volumes with the same compose project name, so the volume names match.

1. Stop the stack:

   ```bash
   docker compose down
   ```

2. Create the two volumes:

   ```bash
   docker volume create toposcope_ch_data
   docker volume create toposcope_app_data
   ```

3. Unpack each archive into its volume:

   ```bash
   docker run --rm -v toposcope_ch_data:/data -v "$(pwd)":/backup alpine \
     tar xzf /backup/ch_data.tgz -C /data
   docker run --rm -v toposcope_app_data:/data -v "$(pwd)":/backup alpine \
     tar xzf /backup/app_data.tgz -C /data
   ```

4. Start the stack and wait until it is healthy:

   ```bash
   docker compose up -d --wait
   ```

Compose may warn that `toposcope_ch_data` already exists and was not created by Compose. That is the restore. Do not set `external: true` on packaged `compose.yml`.

## Rollback

There are two ways back:

- `./upgrade.sh rollback --yes` goes back to the last backup the script took, from 0.6.1 on (see [Backup and rollback commands](#backup-and-rollback-commands)). What was stored since is lost.
- By hand: pin a previous published image tag in `compose.yml` and run `docker compose up -d`. The data stays, unless the release's line under [Pins by release](#pins-by-release) or its section below says otherwise.

SQLite migrations add columns. Extra columns on a downgrade are unused, not a wipe. If a ClickHouse data directory from an older release refuses to start after the migration, use a restore rather than a tag pin.

### Pins by release

`0.3.14` is the first public pin. To roll back application code from a release, pin the one before it:

| From | Pin | Notes |
| --- | --- | --- |
| 0.15.6 | `0.15.5` | Changes no tables. A Number panel saved on 0.15.6 through the panel sheet keeps the width it was saved at (at least 3 columns), which 0.15.5 reads as it is |
| 0.15.5 | `0.15.4` | Changes no tables. On 0.15.4 `GET /share/v1/latest` answers 404 |
| 0.15.4 | `0.15.3` | See [Back from 0.15.4](#back-from-0154) |
| 0.15.3 | `0.15.2` | Changes no tables; only `upgrade.sh` changed |
| 0.15.2 | `0.15.1` | Changes no tables |
| 0.15.1 | `0.15.0` | Changes no tables |
| 0.15.0 | `0.14.2` | Changes no tables and no stored data, only how screens are drawn |
| 0.14.2 | `0.14.1` | See [Back from 0.14.2](#back-from-0142) |
| 0.14.1 | `0.14.0` | Changes no tables |
| 0.14.0 | `0.13.1` | See [Back from 0.14.0](#back-from-0140) |
| 0.13.1 | `0.13.0` | Changes no tables |
| 0.13.0 | `0.12.3` | Leaves its new tables unread, so it shows no Coverage, accepted gaps or code links. Pinning 0.13.0 again picks them up where they were |
| 0.12.3 | `0.12.2` | Changes no tables |
| 0.12.2 | `0.12.1` | Changes no tables |
| 0.12.1 | `0.12.0` | Leaves its new table and column unread, so every browser asks for the two-step code again there |
| 0.12.0 | `0.11.1` | 0.12.0 changes column codecs in place and stops writing one copy of a row's attributes. 0.11.1 reads both as they are, but a log row stored by 0.12.0 shows no attributes there, though searches and facets on them still find it |
| 0.11.1 | `0.11.0` | Changes no tables. Its ClickHouse sizing lives in `compose.yml`, so going back means 0.11.0's `compose.yml` too, which `./upgrade.sh rollback --yes` puts back |
| 0.11.0 | `0.10.1` | Leaves its new column unread, so an agent shows as a plain service account |
| 0.10.1 | `0.10.0` | The 0.10.1 changelog says what stays as 0.10.1 left it (removed monitors, the rekeyed rollups) |
| 0.10.0 | `0.9.0` | See [Back from 0.10.0](#back-from-0100) |
| 0.9.0 | `0.8.0` | See [Back from 0.9.0](#back-from-090) |
| 0.8.0 | `0.7.3` | See [Back from 0.8.0](#back-from-080) |

### Back from 0.15.4

0.15.4 adds a setting for services kept longer, which 0.15.3 leaves unread. With a service kept longer, 0.15.4 changes the retention of logs, their per-minute counts and spans. 0.15.3 puts every service back on `retention_days` at boot, so a kept service's older rows are deleted as ClickHouse applies TTL. Remove the services from Kept longer, or take a backup, first.

### Back from 0.14.2

0.14.2 changes no tables, but 0.14.1 reads a board with its first six panels only, without its section headings and note panels, a stat or Top-N panel without its note, and a panel taller than 8 rows as 8 rows. A board saved there keeps what 0.14.1 read.

### Back from 0.14.0

0.14.0 adds the GitHub connection and a repository path, which 0.13.1 leaves unread, and rewrites every board into panels at boot. ClickHouse is unchanged.

On 0.13.1 a board then opens with its inputs and the canvas it had before 0.14.0, without its window input, and a board made or edited on 0.14.0 opens without its panels. Restore the backup taken before the upgrade to get boards back exactly.

### Back from 0.10.0

0.10 adds tables and columns only, and stops links made before it (see [Upgrading from 0.9](#upgrading-from-09)). Pinning 0.9.0 again leaves them unread. Links stopped at the upgrade stay stopped, and links made under 0.10 do not work there. What else changes on 0.9.0 is under [Going back to 0.9.0](#going-back-to-090).

### Back from 0.9.0

0.9 replaces the shared password with people (see [Upgrading from 0.8](people.md#upgrading-from-08)). Pinning 0.8.0 again needs `TOPOSCOPE_PASSWORD` back in `.env`.

0.8.0 ignores people, their tokens, invites, Owner links, provider sign-ins and the new columns, and nobody can sign in there as a person. Ingest tokens made or imported on 0.9 keep working on 0.8.0, since they are kept where 0.8.0 reads them.

### Back from 0.8.0

0.8.0 adds columns only. 0.7.3 leaves them unread:

- a pin is not Home on 0.7.3;
- a monitor calls only its first webhook and compares its series (a share-of-all-rows monitor reads as a count);
- a paused link pulls again;
- a share serves its scope with raw params whatever its panels.

Pinning 0.8.0 again picks them up where they were.

### Monitors on an older release

0.6.0 adds tables for monitors. 0.5.7 ignores them, and a push or HTTP(S) monitor's rule, which has no saved search, does not run there. Pinning 0.6.0 again picks them up where they were.

TCP and certificate monitors add a table of their own. A release before them ignores it and does not run them: Watch lists each as a search monitor with no search, and one that was open stays open until they run again.

## Upgrade notes up to 0.7.1

Each release up to 0.7.1 kept its upgrade notes here. Later releases carry a **Before you upgrade** paragraph in [CHANGELOG.md](../CHANGELOG.md), which the footer's release panel shows.

### 0.4.9

0.4.9 changes fingerprint hash inputs for normalized paths and parsed stacks. Existing rows keep their stored ids, so affected errors can receive a new id once when upgraded. Later events use the corrected inputs; see [exception fingerprints](ingest.md#exception-fingerprints).

### 0.4.11

0.4.11 does the same for three stack shapes: a Python traceback deeper than 50 frames, a Node `at async <path>` frame, and a PHP closure frame named with its file and line. Errors with one of those can receive a new id once when upgraded.

### 0.5.0

0.5.0 answers an OTLP protobuf request in protobuf, as the protocol says; every reply was JSON before. A script that read `ingested` from the reply to a protobuf request has to send JSON instead.

Boot adds one ClickHouse table, which holds whether a metric name is a gauge or a counter. Rolling back to 0.4.12 leaves it in place and unused, and a counter then draws as an average again.

### 0.5.2

0.5.2 publishes one more loopback port from the packaged `compose.yml`: `127.0.0.1:4319`, for OTLP over gRPC. The app container does not start if something on the host already has that port; change the host side of that mapping in `compose.yml`, or remove it.

Boot adds two ClickHouse tables, which hold histogram buckets. A histogram stored before the upgrade has no buckets, so its percentiles start with the first export afterwards; its count, sum and average read from the start.

Rolling back to 0.5.1 leaves the tables in place and unused: a histogram is listed as its `.count` and `.sum` again, and a saved search or link that carries a reading (`metric=p99:…`) is refused there.

`vector.yaml` now also listens for OTLP on ports 4317 and 4318 and keeps its buffers under `VECTOR_DATA_DIR`. So the quick start's Vector step sets that directory, and Vector keeps running after its three smoke events.

### 0.5.4

0.5.4 adds one ClickHouse table at boot, which keeps the unit each metric name was last sent with. SQLite gains browser sessions, a record of fingerprints already sent, and new columns on alert rules.

A browser now gets a sign-in page instead of the password prompt. Its session lasts 30 days and ends on Sign out or when `TOPOSCOPE_PASSWORD` changes. Scripts and agents that send Basic auth or the ingest token are unchanged. `TOPOSCOPE_PUBLIC_URL` is optional and only adds links to alerts.

Rolling back to 0.5.3 leaves the new table and columns in place and unused: metric units are no longer shown, sign-in falls back to the browser's prompt, and the bare address opens a plain search instead of Home.

0.5.3 reads every alert rule as a threshold alert, so before rolling back, delete or silence new-fingerprints alerts. Otherwise each one pages whenever its saved search has at least its N events in the window. An alert with a body of its own goes back to the default body.

### 0.5.5

0.5.5 adds links. Boot adds columns to the logs, change marks and their per-minute counts that record where each row entered and in what order it arrived, and a table for that order. The first feed read adds an index by arrival.

Every row and per-minute count already stored is kept. Rows stored before have no arrival position, so a link does not carry them. A link needs `/link/v1/` reachable at the address in its key: see [Reaching the other instance](links.md#reaching-the-other-instance).

Rolling back to 0.5.4 leaves the new columns, table and index in place and unused: links stop, Search draws no toposcope group, and rows already pulled stay as ordinary rows. 0.5.4 stores new rows without an arrival position or an instance name, so after rolling forward again a link does not carry rows stored in between.

### 0.5.6

0.5.6 changes what panel titles, the Alerts list and Search draw, and nothing at boot: rolling back to 0.5.5 is the pin alone.

### 0.5.7

0.5.7 adds one ClickHouse table at boot, which keeps the description each metric was sent with. Rolling back to 0.5.6 leaves it in place and unused, and descriptions are no longer shown.

A panel there draws only its own metric: its merged lines, line names, title and note are not read, and a saved search saved again there loses them. A link made on 0.5.7 that carries them can open that panel with its Replace and log-scale switches wrong.

### 0.6.0

0.6.0 turns alerts into monitors, and changes nothing in ClickHouse at boot. SQLite gains columns and tables for monitors.

Every alert becomes a monitor that keeps calling once per window while it is open, and now also sends one resolved call when it closes. An alert with a body of its own sends no resolved call until it is given a resolved body. The Alerts view is now Watch, and an old `?view=alerts` link lands there.

Push monitors (`POST /v1/checks`, `/ping/<key>`) and HTTP(S) monitors are new, and so are a Settings default webhook and `TOPOSCOPE_WATCHDOG_URL` (see [Who watches Toposcope](monitors.md#who-watches-toposcope)).

Rolling back to 0.5.7 leaves the new columns and tables in place and unused. Every rule goes back to calling once per window, with no resolved call, and push and HTTP(S) monitors do not run there; nor does a monitor that relies on the default webhook.

Before rolling back, pause or delete every fewer-than monitor. 0.5.7 reads it as at least, and calls whenever its search has its N lines: that is, all the time while the stream is healthy. A monitor paused in 0.6.0 stays skipped.

### 0.6.1

0.6.1 changes nothing in ClickHouse at boot. SQLite gains one table for TCP and certificate monitors, and two settings for the release check.

From this version Toposcope reads GitHub's public releases list once a day (see [What Toposcope calls out to](operations.md#what-toposcope-calls-out-to)); `TOPOSCOPE_UPDATE_CHECK=off` stops it. Upgrades from 0.6.1 on can use `upgrade.sh`, which 0.6.1 is the first release to ship.

Rolling back to 0.6.0 leaves the table and settings in place and unused: TCP and certificate monitors do not run there, and the footer shows no version.

### 0.6.2

0.6.2 adds one optional setting, `metrics_retention_days`, and changes nothing until it is set: metrics follow `retention_days` as before. Once set, boot and every save apply it to metric points, histogram buckets and their per-minute counts.

Rolling back to 0.6.1 applies `retention_days` to metrics again at boot, so metrics older than that are deleted as ClickHouse applies TTL. Set metrics back to follow logs, or take a backup, first.

### 0.6.3

0.6.3 changes nothing in ClickHouse or SQLite at boot. **Check now** and the upgrade button are new in the version popover. Upgrading from the app stays off until the host runs `sudo ./upgrade.sh enable-ui`, and it writes only `upgrade/` in the app's volume.

Before rolling back to 0.6.2, run `sudo ./upgrade.sh disable-ui` if it was turned on. 0.6.2's `upgrade.sh` has no `ui-run`, so the unit would fail on a click that 0.6.2's popover can no longer make.

### 0.7.0

0.7.0 adds shares (see [Shares](shares.md)) and changes nothing in ClickHouse at boot. SQLite gains one table for shares; a share's use is written as `service:toposcope` log rows.

Every page now sends `Content-Security-Policy: frame-ancestors 'none'`, so a page that framed Toposcope stops showing it; embed a share's panel instead.

Rolling back to 0.6.3 leaves the table in place and unread: share reads, tickets and embeds answer as unknown paths there, and framing is allowed again.

### 0.7.1

0.7.1 changes nothing in ClickHouse or SQLite. A panel's chart pick and a Top-N donut are saved in its `w=` token and saved-search JSON. `/embed` may now be framed by Toposcope itself, for the Share dialog's preview.

Rolled back to 0.7.0, bars and stacked bars draw as lines. A donut panel's link reads as a Top-N of an attr that does not exist: switch it back to Bars before rolling back, or pick its key again after. A heatmap panel draws nothing.
