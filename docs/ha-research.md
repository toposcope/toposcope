# HA research

Research for the [One node](../ROADMAP.md#one-node) rule, written against 0.15.1 (`b5915bc`). Nothing here is locked. It sets out what a lost node costs today, what has to change for Toposcope to survive one, the design that does it, and the choices that lock it.

The constraints that bind: self-host only, no hosted control plane; no Helm, k8s, or S3 / cold volume ([Will not](../ROADMAP.md#will-not)); Vector is the collector and there is no Toposcope ingest daemon; much lighter than Graylog or OpenSearch.

## In short

- Toposcope is built as **one writer**. The arrival counter that orders rows for links, the monitor pass, HTTP checks, link pulls and the dedupe of pulled rows are each guarded by a variable in one process. Two app processes on one store would page twice, probe twice, store pulled rows twice and hand out the same arrival positions to different rows.
- The design: **a cluster**, two containers on each node. Toposcope (Bun for the web, API and ingest; a Go control service with embedded dqlite for all control state and all background work) and ClickHouse (replicated, with Keeper in cluster mode). Standalone is the pair on one machine; HA is the same pair on three machines.
- One machine lost loses nothing acknowledged; recovery under a minute. About 40 PRs, gated on a proof of dqlite. The first steps ship as single-node releases and fix the one-writer problems above on a single node too.
- A cluster is one installation. A link stays a link between installations and is never the HA mechanism.

## 1. What lives where, and what a dead box costs today

### ClickHouse (`ch_data`)

Every table is a plain `MergeTree` or one of its single-node siblings. There is no `Replicated*` engine, no `ON CLUSTER` and no Keeper anywhere in the repository.

| Table | Engine | Notes |
| --- | --- | --- |
| `logs` | MergeTree, by day | `seq`, `src_id`, `src_seq` for links (`src/shared/migrate.ts:176`) |
| `logs_by_minute`, `logs_attr_keys_by_minute`, `logs_attr_values_by_minute`, `logs_attr_numeric_by_minute` | AggregatingMergeTree, fed by MVs from `logs` | dropped and made again on each boot when their key differs; empty days backfilled at boot (`migrate.ts:490–664, 925–1070`) |
| `metrics`, `metric_buckets` and their `_by_minute` rollups | MergeTree / AggregatingMergeTree | metrics retention (`migrate.ts:666–762`) |
| `spans`, `profile_samples`, `change_marks` | MergeTree | `migrate.ts:825–887` |
| `monitor_results` | MergeTree | every result of every monitor (`migrate.ts:394`) |
| `arrival_seq` | MergeTree, no TTL | the block of arrival positions reserved ahead (`migrate.ts:359`) |
| `field_role_skip` | ReplacingMergeTree | truncated and refilled at boot (`migrate.ts:450–471`) |

Each app boot runs the whole migration (`src/index.ts:698`); there is no schema version table. Retention is TTL only, set at boot and on save (`migrate.ts:141`).

### SQLite (`app_data`, `/data/toposcope.sqlite`)

One file, WAL, opened once per process (`src/control/index.ts:21–45`), no `busy_timeout`. About 425 synchronous `bun:sqlite` calls across 41 files.

| What | Tables |
| --- | --- |
| People and sign-in | `people` (password hash, sealed TOTP seed), `sessions`, `person_tokens`, `invites`, `owner_links`, `remembered_browsers`, `oidc_states` |
| Machines | `api_tokens` (hashed ingest tokens) |
| Hunts and boards | `saved_searches`, `person_pins` |
| Monitors | `alert_rules` (state on the rule), `monitor_stretches`, `monitor_calls`, `monitor_http`, `monitor_net` (`next_run_at`, `fails_in_row`), `alert_sent_fingerprints` |
| Links | `link_keys`, `links` (the pull position and the peer's secret), `feeds`, `pulled_monitors`, `link_volume` |
| Shares, fields, code | `shares`, `field_roles`, `field_links`, `coverage_accepted*`, `repositories`, `github_connection` (GitHub's token) |
| `settings` | `instance_id` (also names the session cookie), `instance_name`, `session_secret` (signs cookies, seals TOTP and the OIDC secret unless `TOPOSCOPE_SESSION_SECRET` is set), retention, default webhook, the release check |

Also in `app_data`: `/data/upgrade/` (the request and status files for upgrading from the footer, `src/control/upgrader.ts`). `.env` lives on the host, outside both volumes and outside the backup.

### In the process only

The arrival counter (`src/ingest/arrival-seq.ts:27–31`), the syslog UDP queue (10,000 rows), the half-assembled Prometheus histograms (30 s), the sign-in throttle, share rate limits and use tallies, the GitHub device code, and the "pass still running" flags of every loop. No ingest batching: a sender gets its 2xx only once ClickHouse has answered the insert (`src/ingest/index.ts:146–157`). Live is polled; there are no sockets to move.

### When the box dies

- Everything stops: search, boards, monitors, links served from here, shares embedded elsewhere, MCP. The watchdog's check-ins stop, so the outside service pages; that is the only page.
- Senders: Vector's packaged disk buffer (256 MB per sink, `when_full: block`, `vector.yaml:97–119`) holds and retries; OTLP SDKs and collectors retry for their own limit (the Collector's default is 5 minutes, then the batch is dropped [1]); syslog over UDP is lost.
- Getting back means a new box, and the last backup. `upgrade.sh backup` is a cold tar of both volumes with the stack stopped (`upgrade.sh:203–243`), kept on the same host, last 2 only. Unless the operator copies backups elsewhere, a dead disk loses everything; with copies, everything since the last one.
- Links: an edge's own store is the buffer, so a centre that comes back from a backup re-pulls from its stored position. A centre lost without backup must be linked again, and reads every source from its start.

## 2. What must run once, and what two app processes would do

Nothing coordinates across processes. Every guard is a module variable or a `Map`.

| Work | Period | Guard today | Two processes |
| --- | --- | --- | --- |
| Monitor pass (`src/alerts/cron.ts:130–171`) | 60 s | `passRunning` flag | Both evaluate. A stretch is read, then begun, outside one transaction (`monitor.ts:268–286`), so both can open one. Every open, reminder and resolved call is sent twice: the send is not claimed first (`monitor.ts:177–265`, one attempt in `delivery.ts:113–131`). New-fingerprint calls the same (`first-seen.ts:207–251`). |
| HTTP, TCP, cert checks (`http-cron.ts:25–103`) | 1 s tick, each monitor 30 s–1 h | in-process `running` set | `next_run_at` is moved with a plain `UPDATE` (`http-store.ts:126`), so both probe the same target, race on `fails_in_row` and write two results. |
| Push lateness (`push.ts:123–147`) | in the pass | none | both can open the missed stretch |
| Watchdog (`watchdog.ts:62–86`) | end of each pass | none | two check-ins a minute: a dead process hides behind a live one |
| Link pull (`src/links/puller.ts:208–251`) | 5 s | `running` flag; `onePulledAtATime` (`src/ingest/pulled.ts:17`) | Dedupe is read-then-insert (`pulled.ts:55–75`, `src/feed/wire.ts:143–149`), serialised only in one process, so both store the row. `links.position` is written last-writer-wins (`src/links/store.ts:171`) and can move back. |
| Arrival positions (`arrival-seq.ts`) | each insert | module counter, blocks of 100,000 | Both start from the same top and hand out the same numbers to different rows. Downstream, `(src_id, src_seq)` then collides and the second row is dropped as already held. `arrivalSeqSettled()` counts only its own process, so a feed can move past rows the other is still writing and a puller skips them for good. |
| Boot migration | each start | none | Two boots can both backfill one missing day into a rollup (doubled counts), both rebuild an MV (rows in between miss the rollup), and one truncates `field_role_skip` under the other. |
| Retention | boot, on save | none | converges; one may kill the other's TTL mutation |
| Release check (`release-check.ts:206`) | daily | none | two calls a day; harmless |
| Share and access tallies | 60 s | none | one row per process; harmless, but share rate limits are per process |
| Prometheus buckets | 5 s | none | a histogram split across processes is stored in two halves |

So each of these needs **one owner** across the cluster, and the owner must be checked on every write, not held in a variable. Section 3 does that with ownership records and generations in the control service. Spreading the work across nodes is a later step.

## 3. The design: a cluster

A Go control service with dqlite, and replicated ClickHouse. A takeover is automatic: when a member is lost, its work moves to another once ownership and readiness are checked.

### Shape

Two containers on every node, as today:

| Container | Contents | Holds |
| --- | --- | --- |
| **toposcope** | Bun: UI, public API, query building, search, ingest protocols. Go: the control service with dqlite embedded. s6 supervises both [2]. | dqlite (control state), node identity, the secrets it needs |
| **clickhouse** | the upstream image; Keeper embedded in cluster mode | telemetry, rollups, Keeper state |

Standalone is the pair on one machine. HA is the same pair on three machines, six containers; three is the minimum. No two-node HA, no witness-only node, no sharding, no cluster stretched across regions in the first release.

Bun and Go ship in one image because they release together and share `/data`; ClickHouse stays its own container so an app restart or rollback never restarts or downgrades ClickHouse, its memory limit stays its own (`clickhouse_size` sizes it from its container), and its image stays upstream's. Only Go opens dqlite; Bun calls it over a Unix socket, and file permissions keep Bun out of the database files.

### What Go owns

All control state and all background work, behind a versioned internal API with generated TypeScript types. Operations, not SQL: create or change a monitor, check a session or an ingest token, claim a scheduled run, commit a run's result with its monitor move and its pending call, advance a link position, join, drain or remove a member. Each operation that changes several rows is one short transaction in Go; probes, ClickHouse queries and webhooks run outside any transaction. Bun keeps the UI, query builder, charts and protocol parsers, and stops opening SQLite.

### Why dqlite

Canonical's C library: SQLite under Raft, linked into the process that uses it, with ordinary multi-statement transactions. A write is acknowledged once a quorum has persisted it; the database itself is held in memory and the Raft log is what goes to disk [3], so it suits a small control database and never a copy of telemetry. Reads are served by the leader without first checking it still leads, so a read can be stale by up to an election timeout, "a few hundred milliseconds" by default [4]: a read never proves ownership, and every claim is a conditional write. It is reached from Go through `go-dqlite`, which binds the C library [5]; Bun cannot load it, hence the Go service. Incus, often cited as dqlite in production, now runs Cowsql, a fork [6], so its record is not dqlite's own.

Moving behind a Go service also changes every one of the ~425 SQLite calls, but into operations with their transactions in one place, rather than into SQL sent over HTTP (rqlite [7], which also refuses explicit `BEGIN`/`COMMIT`).

### What lives where

dqlite holds bounded operational state: people, sessions, tokens, settings, hunts and boards, monitors and their current state, runs waiting, the call outbox, link positions. ClickHouse holds telemetry and history, including `monitor_results` as today. Finished operational rows expire. dqlite keeps its database in memory [3], so nothing telemetry-sized goes there.

### One owner for each piece of work

The first clustered release keeps today's model, one scheduler, one ingest owner and one owner per link pull, but each ownership is a durable record with a generation. Every write from an owner carries its generation and Go refuses an old one, so a paused worker that wakes cannot overwrite current state. A monitor run is: make a run id, claim it, check, commit result + move + call intent together, deliver from the outbox. That fixes every row of the table in section 2. It does not make webhooks exactly once: a call whose acknowledgement was lost is sent again, so each call carries a stable id a receiver can dedupe on. Spreading runs across nodes can come later.

### Telemetry

Replicated tables on Keeper, `insert_quorum = 2` of three, one policy, never weakened quietly when a replica is down: with two replicas lost, ingest refuses. Two fixes in the app: an origin identity that no new writer can reuse (the arrival counter becomes a block allocator in Go, claimed by conditional write), and a link position that moves only after its rows meet the quorum, with a feed that follows completed writes, not a per-process counter (`arrivalSeqSettled()` today). A replica that is behind is kept from monitor evaluation until it is current, or the pass says it is delayed, so a takeover does not page *fewer than* on missing rows.

ClickHouse replication is per table, "asynchronous and multi-master" [8]. Keeper holds the replicas' metadata under Raft, so 3 Keeper members survive 1 lost [9]; it runs inside `clickhouse-server` [9]. With Keeper gone, replicated tables refuse writes [8]. `insert_quorum` makes an insert wait for N replicas and fails when fewer are up [10]. Inserted blocks are deduplicated [8, 11], but Toposcope stamps a fresh arrival position on each try, so a retried request is never the same block; the origin identity above is what dedupes. Existing tables turn replicated in place (a `convert_to_replicated` flag file, or `ATTACH TABLE … AS REPLICATED`) [8], and every DDL must then reach every replica (`ON CLUSTER`, or a `Replicated` database [12]), which the boot migration does not do today.

### Cluster and link are different things

A cluster is one installation: one identity and public URL, one set of people, tokens, boards, monitors and settings, replicated underneath, members replaced on their own. A link joins separate installations, each with its own identity, admins, retention and availability, across sites or regions. Links carry no control-plane snapshot and never move an identity.

### Failure contract

| Event | Behaviour |
| --- | --- |
| One machine fails | the other two keep both quorums; work resumes once ownership and readiness are checked |
| Network splits 2–1 | the majority carries on; the lone member can commit no control change and meet no insert quorum |
| A worker pauses, then resumes | its old generation commits nothing; a webhook may still go twice |
| A failed machine returns | rejoins and catches up before it takes work |
| Quorum is lost | writes stop; there is no "force primary" |
| A new replica is behind | kept from freshness-bound work until ready |

The promise: one machine lost, no acknowledged control change or telemetry lost. Not: no interruption, exactly-once calls, or two machines lost at once. Target recovery under a minute, then publish what failure tests measure.

### During a takeover

Vector's HTTP-based sinks retry 408, 429 and every 5xx but 501, without limit by default [13], and the packaged config buffers 256 MB per sink on disk and blocks when full (`vector.yaml:97`). The app answers 503 while not ready, 429 when busy, and gRPC `UNAVAILABLE` for both (`src/ingest/otlp-grpc.ts:58`). So a sender behind Vector loses nothing across a takeover shorter than its buffer, provided the address it sends to reaches a live node. An OTLP Collector retries for 5 minutes by default and keeps its queue in memory unless given `file_storage` [1]. Syslog over UDP is lost while nothing listens on the address, as in an upgrade today.

Vector has one `uri` per sink, so that address is the load balancer's. `TOPOSCOPE_PUBLIC_URL` is the same address, so link keys and alert links follow the cluster, not a member.

### Operator sets up

Three machines on one low-latency network; `toposcope init` on the first, a join token (expiring, authenticated, over encrypted peer traffic) on the other two; peer ports open only between them; a load balancer with a health check on every node's `/api/health`. One proxy on a fourth machine is still one point of failure, so the docs name a tested redundant front (two proxies with a floating IP, or the operator's HA load balancer).

### upgrade.sh

Rolling, one node at a time, each caught up before the next. Migrations run once per cluster, versioned, on the scheduler's owner, with `ON CLUSTER` for ClickHouse; the boot-time MV rebuilds and backfills of section 2 become one-off migration steps. Each release names the dqlite, `go-dqlite` and ClickHouse versions it was tested with, and which earlier release it can roll back to: separate containers make rollback possible, not automatically safe.

### Backup

A manifest with versions, the secrets a restore needs and recovery points; dqlite's backup and ClickHouse `BACKUP` [14] from one replica, copied off the cluster; `toposcope restore` tested in CI.

### Links

Unchanged as federation. Positions move into dqlite with the rest; one owner pulls each link.

### Costs

- A second language and a C dependency: `go-dqlite` binds the dqlite C library [5], packaged for Linux. The image builds it for amd64 and arm64; `bun run dev` on a Mac runs the control service in a container.
- Every request's session or ingest-token check becomes a socket call to Go instead of a SQLite read in process, so it needs a cache that the token's generation can void.
- Three machines for HA. A cluster is six containers with three ClickHouse replicas, closer to Graylog's weight; standalone stays two containers.

### Effort

About 40 PRs, in this order:

1. **Prove dqlite first** (~3): a three-node Go harness running Toposcope-shaped transactions through leader loss, partitions, paused processes, restarts, backup and restore, measuring stale reads and memory. This is the gate: if it fails, the cluster does not go ahead on dqlite.
2. **The Go boundary, standalone** (~15): the image with s6, the internal API and generated types, then one domain at a time (people and sessions, tokens, hunts and boards, monitors, links, shares, settings, fields and repositories), each with one writer and a tested export back to SQLite.
3. **Background work in Go** (~6): claims, generations, run ids, the outbox, the scheduler, link pulls.
4. **Identity and replay** (~4): the arrival allocator, positions after quorum, the feed on completed writes.
5. **Replication and the cluster** (~9): Keeper and replicated tables with in-place conversion, `init`/`join`/`status`/`drain`/`remove`, readiness, migrations once per cluster, rolling `upgrade.sh`, backup and restore.
6. **Failure tests before HA ships** (~3): writes acknowledged just before a kill, inserts cut half way, positions cut half way, stale workers, returning nodes, upgrades, restores.

Steps 1–4 ship as ordinary single-node releases; HA ships after 6.

## 4. What Ian decides to lock it

1. **Go and dqlite.** A second language in the repository and a C library in the image, for the control plane and all background work.
2. **Three machines is HA.** No two-node HA in the first release.
3. **One durability policy:** two of three replicas acknowledge every insert, and ingest refuses rather than weaken it.
4. **When the One node rule lifts.** When clustered HA ships (after step 6), or earlier.
5. **What fails the dqlite proof**, and what then: rqlite [7] behind the same Go API, or a lighter design.
6. **Compatibility rules:** each release names its tested dqlite / `go-dqlite` / ClickHouse versions and how far back it can roll.
7. **Roadmap wording.** "Checks from more than one place" stays in Will not: a cluster runs each check once, from whichever member owns it.

## Sources

1. OpenTelemetry Collector, [exporterhelper](https://github.com/open-telemetry/opentelemetry-collector/blob/main/exporter/exporterhelper/README.md)
2. Docker, [Run multiple processes in a container](https://docs.docker.com/engine/containers/multi-service_container/); [s6-overlay](https://github.com/just-containers/s6-overlay)
3. Canonical, [dqlite replication](https://canonical.com/dqlite/docs/explanation/replication)
4. Canonical, [dqlite consistency model](https://canonical.com/dqlite/docs/explanation/consistency-model)
5. [go-dqlite](https://github.com/canonical/go-dqlite)
6. Incus, [About the Incus database](https://linuxcontainers.org/incus/docs/main/database/)
7. rqlite, [FAQ](https://rqlite.io/docs/faq/)
8. ClickHouse, [Data replication](https://clickhouse.com/docs/engines/table-engines/mergetree-family/replication)
9. ClickHouse, [ClickHouse Keeper](https://clickhouse.com/docs/guides/sre/keeper/clickhouse-keeper)
10. ClickHouse, [insert_quorum](https://clickhouse.com/docs/reference/settings/session-settings/insert-quorum)
11. ClickHouse, [replicated_deduplication_window](https://clickhouse.com/docs/reference/settings/merge-tree-settings/replicated-deduplication-window)
12. ClickHouse, [Replicated database engine](https://clickhouse.com/docs/engines/database-engines/replicated)
13. Vector, [HTTP sink](https://vector.dev/docs/reference/configuration/sinks/http/)
14. ClickHouse, [Backup and restore](https://clickhouse.com/docs/operations/backup)
