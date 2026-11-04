# HA research

Research for the [One node](../ROADMAP.md#one-node) rule, written against 0.15.1 (`b5915bc`). Nothing here is locked. It sets out what a lost node costs today, what has to change for Toposcope to survive one, four whole designs, and a recommendation with the choices that lock it. Designs A–C came first; design D came out of review and is the recommendation.

The constraints that bind: self-host only, no hosted control plane; no Helm, k8s, or S3 / cold volume ([Will not](../ROADMAP.md#will-not)); Vector is the collector and there is no Toposcope ingest daemon; much lighter than Graylog or OpenSearch.

## In short

- Toposcope is built as **one writer**. The arrival counter that orders rows for links, the monitor pass, HTTP checks, link pulls and the dedupe of pulled rows are each guarded by a variable in one process. Two app processes on one store would page twice, probe twice, store pulled rows twice and hand out the same arrival positions to different rows. So every design below keeps **one owner for each piece of work** (A–C: one active app; D: any node serves the UI and queries, but the scheduler, ingest and each link pull have one owner). Spreading that work across nodes is a later step.
- Links already copy every kind from one instance to another every 5 seconds, never store a row twice, and resume after a restart. A second instance that links everything from the first is **already a warm copy of the telemetry**. What it lacks is the control plane (people, hunts, boards, monitors, tokens, links, shares) and a way to take over.
- Replicated ClickHouse needs a third node for ClickHouse Keeper on any layout, and losing no data needs three replicas. Making the control plane survive a node needs a replicated store, and every one of the ~425 SQLite calls changes whichever store it is.
- Recommendation: **design D, a cluster**. Two containers on each node: Toposcope (Bun for the web, API and ingest; a Go control service with embedded dqlite for all control state and all background work) and ClickHouse (with Keeper in cluster mode). Standalone is the same pair on one machine; HA is that pair on three machines. Nothing acknowledged is lost when one machine dies; recovery under a minute. It is the largest build here, about 40 PRs. A cluster is one installation; a link stays a link between installations and is never the HA mechanism.
- Design A (a warm standby made from a link, about 7 PRs) is the light alternative. It is not a step towards D: its snapshot transfer and identity takeover would be built and then thrown away.

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
- Senders: Vector's packaged disk buffer (256 MB per sink, `when_full: block`, `vector.yaml:97–119`) holds and retries; OTLP SDKs and collectors retry for their own limit (the Collector's default is 5 minutes, then the batch is dropped [6]); syslog over UDP is lost.
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

So any design must have **exactly one process** doing the monitor pass, checks, watchdog, link pulls, arrival positions and boot migration, and should send ingest to that same process. Making them safe under two writers is possible (claim rows with `UPDATE … WHERE next_run_at = ?`, positions from a shared counter, dedupe in ClickHouse), but it is a pass through most of `src/alerts`, `src/links` and `src/ingest`, and it buys little while ingest is a small share of the app's 30 MiB and 1 CPU.

## 3. Options by layer

### ClickHouse

**a. A second instance that links everything.** Already shipped. The standby's ClickHouse is its own, with no cluster config. Lag is one pull, 5 s, plus the source's settle. Every kind travels, and a row is never stored twice. Costs: the source keeps a `by_seq_full` projection per kind (about 90 % more disk on `spans`, 130 % on `metrics`, per [operations](operations.md#upgrading-from-09)); a pulled row takes a new position at the standby, so positions differ on the two sides (see Design A, *Taking over*).

**b. ReplicatedMergeTree with ClickHouse Keeper.** ClickHouse's own answer. Replication is per table, "asynchronous and multi-master" [1]; Keeper holds the replicas' metadata and uses Raft, so it needs a majority: 3 Keeper nodes survive 1 lost [2]. It can run inside `clickhouse-server` or on its own [2]. With Keeper gone, replicated tables refuse writes [1]. `insert_quorum` makes an insert wait for N replicas, and fails when fewer are up [7], so with two data replicas a quorum of 2 stops ingest when one dies; no data loss needs three replicas and a quorum of 2. Inserted blocks are deduplicated [1, 8], but Toposcope stamps a fresh arrival position on each try, so a retried request is never the same block. Existing tables can be turned replicated in place (`convert_to_replicated` flag file, or `ATTACH TABLE … AS REPLICATED`) [1]. Every DDL then has to reach every replica (`ON CLUSTER`, or a `Replicated` database, which replicates the DDL through Keeper [9]), which the boot migration does not do.

**c. A cold standby restored from backup.** `BACKUP … TO Disk/File` is a query on the running server and made incremental with `base_backup` [3], so a host job can ship a backup to a second box every hour or so and restore there on loss. No new runtime parts, but the loss window is the interval, and a restore of a large store takes as long as copying it.

ClickHouse Cloud's SharedMergeTree is not self-hosted and is out.

### SQLite (the control plane)

**a. A snapshot over the standby link.** `VACUUM INTO` a temporary file every minute, offered on one more `/link/v1/` route to the standby, which keeps the last few. No new container, no new dependency; loss window is the interval. It carries everything secret the instance holds (sealed TOTP seeds, the session secret, token hashes, GitHub's token, link secrets), so a key that takes it is a different, much stronger key than a link key today.

**b. Litestream.** A sidecar that streams the WAL to a replica every second by default [4, 5]; 0.5 added point-in-time restore [10]. Replicas: S3 and compatible, GCS, Azure, OSS, NATS, SFTP, WebDAV or a local path [5]. SFTP to the standby node keeps it off object storage. It is a third container, it is a backup to restore from, not a hot replica, and 0.5 cannot read 0.3's files [10].

**c. LiteFS.** Replicated SQLite through a FUSE mount with a primary. LiteFS Cloud was sunset in 2025 and Fly support is thin [11]; it needs FUSE privileges in the container. Not a good base for a self-hosted product.

**d. rqlite.** SQLite under Raft, 3 nodes; reached through an HTTP API, not the file [12]. Every one of the ~425 synchronous SQLite calls would become an async HTTP call, explicit `BEGIN`/`COMMIT` is not supported [12], and it is a third container on every node.

**e. Move the control plane into ClickHouse or Postgres.** ClickHouse has no transactions and no cheap row updates; monitors, sessions and link positions are read-modify-write rows, so it is a poor fit. Postgres fits the data, but HA Postgres means Patroni and etcd or similar, which is the Graylog weight this product avoids, and it is the same ~425-call rewrite.

**f. dqlite, embedded in a Go service.** Canonical's C library: SQLite under Raft, linked into the process that uses it, with ordinary multi-statement transactions. A write is acknowledged once a quorum has persisted it [15]. The database itself is held in memory and the Raft log is what goes to disk [15], so it suits a small control database, never a copy of telemetry. Reads are served by the leader without first checking it still leads, so a read can be stale by up to an election timeout, "a few hundred milliseconds" by default [16]: a read never proves ownership, and claims must be conditional writes. It is reached from Go through `go-dqlite`, which binds the C library and needs it installed [17]; Bun cannot load it, so the control plane moves behind a Go service. Incus, often cited as dqlite in production, now runs Cowsql, a fork [18], so its record is not dqlite's own.

### The app

**Active/passive.** One app serves; the other runs no loops and takes no writes until it takes over. What decides who is active:

- *The operator* (`upgrade.sh promote` on the standby). No split brain unless the operator makes one; the old primary must be kept from coming back as primary (*fencing*, below).
- *A lease in Keeper*, for designs with Keeper. ClickHouse's `KeeperMap` table is a key-value table in Keeper with linearizable writes and, in strict mode, atomic read-and-update [13]: a row `leader → (node, until)` taken and renewed with one `ALTER … UPDATE … WHERE` might serve as a lease. The docs do not present it as a lock, so it needs a spike before it is a plan. Every loop, the migration and the arrival counter start only while the lease is held, and stop at once when a renewal fails.

**Active/active.** Rejected for now, per section 2.

### Collectors during a failover

Vector's HTTP-based sinks retry 408, 429 and every 5xx but 501, without limit by default [14], and the packaged config buffers 256 MB per sink on disk and blocks when full (`vector.yaml:97`). The app already answers 503 while it is not ready, 429 when busy, and gRPC `UNAVAILABLE` for both (`src/ingest/otlp-grpc.ts:58`). So a sender behind Vector loses nothing across a takeover shorter than its buffer, as long as its address now reaches the new node. An OTLP Collector retries for 5 minutes by default and keeps its queue in memory unless given `file_storage` [6]. Syslog UDP is lost while nothing listens, as in an upgrade today.

### The address in front

Vector has one `uri` per sink and no failover between addresses, so the address senders and people use has to move:

- **A floating IP** (keepalived, VRRP) on one network: seconds, no new service, but both nodes on one L2 segment.
- **DNS** with a short TTL: works across networks; clients that cache longer see the old address for a while.
- **The reverse proxy the operator already runs** (Caddy, nginx) with both nodes as upstreams, the primary first and the standby only while the primary fails `/api/health` (nginx `backup`, Caddy's `first` policy): simplest where that proxy is on a third machine.

Toposcope ships none of these; operations docs name them, as TLS does today. Link keys carry `TOPOSCOPE_PUBLIC_URL`, so it has to be the moving name for links to follow.

## 4. Four designs

### A. Warm standby from a link — minutes to recover

**Shape.** Two nodes, each the packaged two containers, the same image. The primary runs as today. The standby is an ordinary instance holding one *standby link*: every kind with an empty filter, plus the control plane snapshot each minute. While standing by it is readable (a second place to search the same rows) and runs nothing of the primary's: its own control plane is empty, the primary's monitors arrive read-only as on any link.

**Operator sets up.** A second box with the install; one key minted on the primary (*Make a standby key*) and pasted on the standby; the moving address (proxy, VIP or DNS); the watchdog on both, pointed at the outside service.

**Taking over.** The operator runs `./upgrade.sh promote` on the standby, or a script runs it when the watchdog pages. It stops the app, puts the last snapshot in place as `/data/toposcope.sqlite`, and starts with:
- the primary's identity: `instance_id`, name and `session_secret` come with the snapshot, so people stay signed in, tokens and shares keep working, and link peers see the same instance;
- the arrival counter set above both its own positions and every `src_seq` it holds from the primary, so a new row can never take a position the primary used;
- a new *feed epoch*: a puller downstream whose position is in the old primary's numbering is told to read again from the start; rows it holds are not stored twice (`wire.ts:143–149` dedupes by origin).

It then runs the primary's monitors, checks and links from the state in the snapshot.

**Fencing.** When the old primary comes back it must not run as primary too, or every monitor pages twice. At boot it asks its standby peer over the link whether it has taken over; if so it starts as a standby of the new primary, and with no answer it starts without loops and says why on `/api/health` until the operator chooses. `upgrade.sh` refuses to start a fenced node.

**Recovery time.** Detection (the watchdog's grace, a few minutes) plus promotion (under a minute) plus the address moving (seconds to the DNS TTL). About 5 minutes by hand, about 2 scripted.

**Data lost.** Telemetry the standby had not pulled yet: one 5 s pull and what was in flight. Control plane changes since the last snapshot: up to a minute (a monitor's stretch that opened in that minute opens again; a call can be sent twice). Senders behind Vector resend what the primary never answered. Syslog UDP during the gap.

**upgrade.sh.** Both sides of a link must run the same link protocol, so upgrade the standby first, then the primary; the link stops for those minutes and catches up. `promote` and `demote` are new subcommands. Rollback stays per node.

**Backup.** Still needed: a standby copies a mistake (a deleted board, a lowered retention) within a minute. The backup could run on the standby, so the primary never stops for it.

**Links.** Unchanged for peers that use the moving address; downstream centres re-read once after a takeover (the new epoch). The standby link itself is not listed among a team's links.

**Effort.** About 7 PRs:
1. Standby key and link: every kind, no filter, marked standby; one per instance.
2. Control plane snapshot over the link (`VACUUM INTO`, kept on the standby, the last 3).
3. Feed epoch in the link protocol (a protocol bump: both sides of every link upgrade).
4. `promote`: snapshot in place, counter above held positions, new epoch.
5. Fencing at boot, and `/api/health` saying standby / fenced.
6. `upgrade.sh` order, `promote`, `demote`; operations docs for the address in front.
7. A two-instance e2e: kill the primary mid-ingest, promote, check no row is lost or doubled behind Vector and no monitor pages twice.

### B. Hot standby, replicated ClickHouse — about a minute, automatic

**Shape.** Two data nodes, each ClickHouse (replicated tables, Keeper inside) and the app; a third small node runs `clickhouse-keeper` alone, so Keeper keeps a majority with one node lost. Five containers. One app holds a lease in Keeper and does everything; the other answers 503 on `/api/health` and runs nothing. SQLite goes to the standby app by snapshot (A's mechanism) or by Litestream.

**Operator sets up.** Three machines; a cluster config on each (remote servers, macros, Keeper ids), which the release would generate from three addresses in `.env`; the address in front tied to `/api/health`.

**Recovery time.** Lease expiry (about 15–30 s) plus the standby app's boot. About a minute, no person needed.

**Data lost.** Telemetry: rows the dying node had written but not yet replicated, usually under a second (no insert quorum; with two replicas a quorum of 2 stops ingest when one dies [7]). Control plane: the snapshot interval.

**upgrade.sh.** Rolling: the passive node, then hand over the lease, then the other. The boot migration must run once, on the lease holder, through `ON CLUSTER` or a `Replicated` database; every MV rebuild and backfill done once. ClickHouse major upgrades replica by replica. Backups become `BACKUP` from one replica [3] instead of a cold tar with the stack stopped.

**Links.** Unchanged: the arrival counter lives with the lease holder, and its positions are the same rows on both replicas, so no epoch is needed.

**Effort.** About 14 PRs: cluster config and Keeper; tables replicated, with an in-place conversion for existing installs; migration once on the holder and through `ON CLUSTER`; the `KeeperMap` lease spike, then the lease; every loop, the counter and ingest gated on it; the control plane snapshot; `upgrade.sh` rolling upgrade and `BACKUP`; a three-node e2e.

### C. Three nodes, no data loss — seconds, automatic

**Shape.** Three nodes, each ClickHouse (replica plus Keeper) and the app; `insert_quorum = 2`, so a sender's 2xx means two replicas hold the row. The control plane on rqlite (a third container per node) so it survives a node with nothing lost, or kept in Keeper. Nine containers. One active app by lease, as in B.

**Recovery time.** Lease expiry plus a warm passive app: well under a minute.

**Data lost.** Nothing a sender was told was stored. Syslog UDP during the gap.

**Effort.** B plus the control plane rewrite: ~425 synchronous SQLite calls to an async remote store, transactions reworked for rqlite's limits [12], a third container everywhere. About 30 PRs, and an install heavier than "two containers" by any reading.

### D. A cluster: Go control service with dqlite, replicated ClickHouse — under a minute, nothing acknowledged lost

**Shape.** Two containers on every node, as today:

| Container | Contents | Holds |
| --- | --- | --- |
| **toposcope** | Bun: UI, public API, query building, search, ingest protocols. Go: the control service with dqlite embedded. s6 supervises both [19]. | dqlite (control state), node identity, the secrets it needs |
| **clickhouse** | the upstream image; Keeper embedded in cluster mode | telemetry, rollups, Keeper state |

Standalone is the pair on one machine. HA is the same pair on three machines, six containers; three is the minimum. No two-node HA, no witness-only node, no sharding, no cluster stretched across regions in the first release.

Bun and Go ship in one image because they release together and share `/data`; ClickHouse stays its own container so an app restart or rollback never restarts or downgrades ClickHouse, its memory limit stays its own (`clickhouse_size` sizes it from its container), and its image stays upstream's. Only Go opens dqlite; Bun calls it over a Unix socket, and file permissions keep Bun out of the database files.

**What Go owns.** All control state and all background work, behind a versioned internal API with generated TypeScript types. Operations, not SQL: create or change a monitor, check a session or an ingest token, claim a scheduled run, commit a run's result with its monitor move and its pending call, advance a link position, join, drain or remove a member. Each operation that changes several rows is one short transaction in Go; probes, ClickHouse queries and webhooks run outside any transaction. Bun keeps the UI, query builder, charts and protocol parsers, and stops opening SQLite.

**What lives where.** dqlite holds bounded operational state: people, sessions, tokens, settings, hunts and boards, monitors and their current state, runs waiting, the call outbox, link positions. ClickHouse holds telemetry and history, including `monitor_results` as today. Finished operational rows expire. dqlite keeps its database in memory [15], so nothing telemetry-sized goes there.

**One owner for each piece of work.** The first clustered release keeps today's model, one scheduler, one ingest owner and one owner per link pull, but each ownership is a durable record with a generation. Every write from an owner carries its generation and Go refuses an old one, so a paused worker that wakes cannot overwrite current state. A monitor run is: make a run id, claim it, check, commit result + move + call intent together, deliver from the outbox. That fixes every row of the table in section 2. It does not make webhooks exactly once: a call whose acknowledgement was lost is sent again, so each call carries a stable id a receiver can dedupe on. Spreading runs across nodes can come later.

**Telemetry.** Replicated tables on Keeper, `insert_quorum = 2` of three, one policy, never weakened quietly when a replica is down: with two replicas lost, ingest refuses. Two fixes in the app: an origin identity that no new writer can reuse (the arrival counter becomes a block allocator in Go, claimed by conditional write), and a link position that moves only after its rows meet the quorum, with a feed that follows completed writes, not a per-process counter (`arrivalSeqSettled()` today). A replica that is behind is kept from monitor evaluation until it is current, or the pass says it is delayed, so a takeover does not page *fewer than* on missing rows.

**Cluster and link are different things.** A cluster is one installation: one identity and public URL, one set of people, tokens, boards, monitors and settings, replicated underneath, members replaced on their own. A link joins separate installations, each with its own identity, admins, retention and availability, across sites or regions. Links carry no control-plane snapshot and never move an identity.

**Failure contract.**

| Event | Behaviour |
| --- | --- |
| One machine fails | the other two keep both quorums; work resumes once ownership and readiness are checked |
| Network splits 2–1 | the majority carries on; the lone member can commit no control change and meet no insert quorum |
| A worker pauses, then resumes | its old generation commits nothing; a webhook may still go twice |
| A failed machine returns | rejoins and catches up before it takes work |
| Quorum is lost | writes stop; there is no "force primary" |
| A new replica is behind | kept from freshness-bound work until ready |

The promise: one machine lost, no acknowledged control change or telemetry lost. Not: no interruption, exactly-once calls, or two machines lost at once. Target recovery under a minute, then publish what failure tests measure.

**Operator sets up.** Three machines on one low-latency network; `toposcope init` on the first, a join token (expiring, authenticated, over encrypted peer traffic) on the other two; peer ports open only between them; a load balancer with a health check on every node's `/api/health`. One proxy on a fourth machine is still one point of failure, so the docs name a tested redundant front (two proxies with a floating IP, or the operator's HA load balancer).

**upgrade.sh.** Rolling, one node at a time, each caught up before the next. Migrations run once per cluster, versioned, on the scheduler's owner, with `ON CLUSTER` for ClickHouse; the boot-time MV rebuilds and backfills of section 2 become one-off migration steps. Each release names the dqlite, `go-dqlite` and ClickHouse versions it was tested with, and which earlier release it can roll back to: separate containers make rollback possible, not automatically safe.

**Backup.** A manifest with versions, the secrets a restore needs and recovery points; dqlite's backup and ClickHouse `BACKUP` [3] from one replica, copied off the cluster; `toposcope restore` tested in CI.

**Links.** Unchanged as federation. Positions move into dqlite with the rest; one owner pulls each link.

**Costs.**
- A second language and a C dependency: `go-dqlite` binds the dqlite C library [17], packaged for Linux. The image builds it for amd64 and arm64; `bun run dev` on a Mac runs the control service in a container.
- Every request's session or ingest-token check becomes a socket call to Go instead of a SQLite read in process, so it needs a cache that the token's generation can void.
- Three machines for HA. A cluster is six containers with three ClickHouse replicas, closer to Graylog's weight; standalone stays two containers.
- The largest build here.

**Effort.** About 40 PRs, in this order:
1. **Prove dqlite first** (~3): a three-node Go harness running Toposcope-shaped transactions through leader loss, partitions, paused processes, restarts, backup and restore, measuring stale reads and memory. This is the gate: if it fails, D does not go ahead on dqlite.
2. **The Go boundary, standalone** (~15): the image with s6, the internal API and generated types, then one domain at a time (people and sessions, tokens, hunts and boards, monitors, links, shares, settings, fields and repositories), each with one writer and a tested export back to SQLite.
3. **Background work in Go** (~6): claims, generations, run ids, the outbox, the scheduler, link pulls.
4. **Identity and replay** (~4): the arrival allocator, positions after quorum, the feed on completed writes.
5. **Replication and the cluster** (~9): Keeper and replicated tables with in-place conversion, `init`/`join`/`status`/`drain`/`remove`, readiness, migrations once per cluster, rolling `upgrade.sh`, backup and restore.
6. **Failure tests before HA ships** (~3): writes acknowledged just before a kill, inserts cut half way, positions cut half way, stale workers, returning nodes, upgrades, restores.

Steps 1–4 ship as ordinary single-node releases; HA ships after 6.

### Side by side

| | A. Warm standby | B. Hot standby | C. Three nodes | D. Cluster |
| --- | --- | --- | --- | --- |
| Nodes / containers | 2 / 4 | 3 / 5 | 3 / 9 | 3 / 6 (standalone 1 / 2) |
| New parts | none | Keeper, cluster config | Keeper, cluster config, rqlite | Keeper, cluster config, Go + dqlite |
| Takeover | by hand or script | automatic | automatic | automatic |
| Recovery | ~2–5 min | ~1 min | < 1 min | < 1 min target |
| Telemetry lost | ~5 s | < 1 s | none acknowledged | none acknowledged |
| Control plane lost | ≤ 1 min | ≤ 1 min | none | none acknowledged |
| Effort | ~7 PRs | ~14 PRs | ~30 PRs | ~40 PRs |
| Two containers per node | yes | yes, plus a Keeper box | no | yes |

## 5. Recommendation

Build **D**. It is the one design that survives a machine with nothing acknowledged lost and keeps two containers a node. It also mends what section 2 found whether or not anyone runs a cluster: ownership with generations, an outbox for calls, positions that cannot be handed out twice, a feed that follows completed writes. Those ship first, as single-node releases, so each step is useful before HA exists. Splitting cluster from link keeps links what they are and keeps the HA promise out of the federation protocol.

The proof of dqlite (step 1) gates the rest. Drop A: its snapshot over a link and its identity takeover would be built and then removed. Do not start active/active, LiteFS, Litestream, rqlite or Postgres.

A stays the answer only if the effort or a second language is not acceptable: two nodes, minutes to recover, seconds lost, about 7 PRs.

### What Ian decides to lock it

1. **Go and dqlite.** A second language in the repository and a C library in the image, for the control plane and all background work.
2. **Three machines is HA.** No two-node HA in the first release.
3. **One durability policy:** two of three replicas acknowledge every insert, and ingest refuses rather than weaken it.
4. **When the One node rule lifts.** When clustered HA ships (after step 6), or earlier.
5. **What fails the dqlite proof**, and what then: rqlite behind the same Go API, or back to A.
6. **Compatibility rules:** each release names its tested dqlite / `go-dqlite` / ClickHouse versions and how far back it can roll.
7. **Roadmap wording.** "Checks from more than one place" stays in Will not: a cluster runs each check once, from whichever member owns it.

## Sources

1. ClickHouse, [Data replication](https://clickhouse.com/docs/engines/table-engines/mergetree-family/replication)
2. ClickHouse, [ClickHouse Keeper](https://clickhouse.com/docs/guides/sre/keeper/clickhouse-keeper)
3. ClickHouse, [Backup and restore](https://clickhouse.com/docs/operations/backup)
4. [Litestream](https://litestream.io/)
5. Litestream, [Configuration reference](https://litestream.io/reference/config/)
6. OpenTelemetry Collector, [exporterhelper](https://github.com/open-telemetry/opentelemetry-collector/blob/main/exporter/exporterhelper/README.md)
7. ClickHouse, [insert_quorum](https://clickhouse.com/docs/reference/settings/session-settings/insert-quorum)
8. ClickHouse, [replicated_deduplication_window](https://clickhouse.com/docs/reference/settings/merge-tree-settings/replicated-deduplication-window)
9. ClickHouse, [Replicated database engine](https://clickhouse.com/docs/engines/database-engines/replicated)
10. Fly.io, [Litestream v0.5.0 is here](https://fly.io/blog/litestream-v050-is-here/); Simon Willison, [on Litestream 0.5](https://simonwillison.net/2025/Oct/3/litestream)
11. Fly.io community, [What is the status of LiteFS?](https://community.fly.io/t/what-is-the-status-of-litefs/23883)
12. rqlite, [FAQ](https://rqlite.io/docs/faq/)
13. ClickHouse, [KeeperMap](https://clickhouse.com/docs/engines/table-engines/special/keeper-map)
14. Vector, [HTTP sink](https://vector.dev/docs/reference/configuration/sinks/http/)
15. Canonical, [dqlite replication](https://canonical.com/dqlite/docs/explanation/replication)
16. Canonical, [dqlite consistency model](https://canonical.com/dqlite/docs/explanation/consistency-model)
17. [go-dqlite](https://github.com/canonical/go-dqlite)
18. Incus, [About the Incus database](https://linuxcontainers.org/incus/docs/main/database/)
19. Docker, [Run multiple processes in a container](https://docs.docker.com/engine/containers/multi-service_container/); [s6-overlay](https://github.com/just-containers/s6-overlay)
