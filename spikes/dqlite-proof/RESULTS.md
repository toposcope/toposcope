# dqlite proof: results

Step 1 of the cluster design in [`docs/ha-research.md`](../../docs/ha-research.md) (branch `claude/ha-research-b67473`): a proof of dqlite before any Toposcope code moves to Go. Nothing in `src/` changes.

**Verdict: dqlite passes the safety gate and does not yet pass the liveness gate.** Across every fault the harness found no duplicate claim, no reused position, no lost acknowledged write, no partial monitor run and no stale owner's write. That holds only with three mitigations the harness had to add, and two problems are still open. The recommendation is at the end.

## How to run

```bash
./run.sh            # both configurations, about 25 minutes
./run.sh default    # or one of them
```

Docker only; nothing is installed on the host. The image builds the dqlite C library from source (v1.18.7, raft bundled) with `go-dqlite` v3.0.4, for linux/arm64 and linux/amd64 (the amd64 image was built under emulation and its binary links and starts; the runs below are arm64). Each run writes `out/<config>/report.md`, `results.json`, the members' logs and every member's acknowledged writes.

What runs: six members (`n1`–`n3` under test, `r1`–`r3` as fresh members for the restore) and a runner, in Compose on their own network, with no port published. The runner drives faults through the Docker socket: `SIGKILL`, `SIGSTOP`/`SIGCONT` of the process, `iptables` inside a member for a 2–1 partition (the runner's own address is never cut, so it can keep asking an isolated member what it believes), restart, and loss of the whole cluster.

| File | What it is |
| --- | --- |
| `cmd/ctl` | a member: dqlite via `go-dqlite/app`, the Toposcope-shaped operations, background workers, an HTTP API for the runner and a Unix socket for Bun |
| `cmd/runner` | faults, workload, measurements, checks, report |
| `bench/auth.ts` | the Bun side of the auth-check benchmark |

### The work it does

All of it Toposcope-shaped, running throughout every fault, from all three members at once, written to be adversarial (an owner writes with the generation it remembers and never checks its own clock first, so a paused owner that wakes does write):

- **Ownership with generations.** A scheduler lease and a link-pull lease. A claim moves the generation on by one and records `(name, gen, owner)`; every write by an owner is conditional on its generation still being current.
- **A monitor run as one transaction.** Fenced on the scheduler generation: the run, its result, the monitor's state move and version bump, a call in the outbox with a stable id, and a pending history-export row.
- **A block allocator** for arrival positions: read `next`, conditional write `next + 1000` where `next` is still the value read.
- **A link position** advanced by the link owner, conditional on its generation.
- **Sessions and tokens**, created and revoked through every member by the runner (about 25 writes a second each), and checked.

Every acknowledged write is recorded where it was acknowledged (members append to a file per member, one `write(2)` per line, so it survives `SIGKILL`); the checks compare those against the database at the end.

### Two configurations

| | default | tuned |
| --- | --- | --- |
| election timeout / heartbeat | 3000 / 500 ms (dqlite's defaults) | 300 / 30 ms (`WithNetworkLatency(20ms)`) |
| raft snapshot | every 1024 entries, keep 8192 (go-dqlite's defaults) | every 128, keep 512 |
| peer TLS | on (see 2 below) | on |
| lease TTL / renew | 3000 / 100 ms | same |

Environment: one Mac (arm64, 8 CPUs) running Docker Desktop. All members share one kernel and clock, and the network is a bridge with sub-millisecond latency. Latencies on a real LAN will be higher by the round trips, and fsync costs are those of Docker Desktop's VM disk.

## Pass / fail

| Criterion | default | tuned | Evidence (default run) |
| --- | --- | --- | --- |
| No duplicate claims | PASS | PASS | 18 claims across 18 generations, none twice, no gaps |
| Stale owner's write refused | PASS | PASS | 1,409 committed runs, none with an older generation after a newer one, none by a member that did not hold that generation; 0 link advances by a non-owner. After `SIGCONT` the paused owners wrote under their old generation 6 times (once per lease held, 3 pauses) and all 6 were refused |
| No reused positions | PASS | PASS | 2,075 arrival blocks of 1,000: 0 overlaps, none past the allocator; 991 link advances, none repeated |
| No lost acknowledged write | PASS* | PASS* | 15,194 sessions, 2,974 revocations, 1,408 monitor runs, 18 claims acknowledged; 0 missing, across leader kill, 5 leader partitions, a follower partition, 3 pauses, two restarts and all three members `SIGKILL`ed at once |
| Monitor run is one transaction | PASS | PASS | 0 runs missing a result, call or history row; 0 orphans; every monitor's version equals its run count |
| Revocation visible everywhere within a stated bound | PASS* | PASS | bound = 2 × election timeout (6 s default, 600 ms tuned); see the table below |
| Lone member commits nothing, answers no revoked session | PASS | PASS | isolated follower: 0 of 5 writes committed, 0 of 28 reads answered at all |
| Memory bounded | **FAIL** | **FAIL** as stated, bounded in fact | see Memory |
| Restore matches the backup | PASS | not run | row checksums of 10 tables equal |
| No acknowledged write before the backup lost | PASS | not run | 1,450 runs and 542 sessions acknowledged before the backup began: all present after restore |
| No reused positions or generations after restore | PASS | not run | with the restore fence (allocator +10¹², generations +10⁶); 45 blocks had been handed out after the dump and would otherwise have been handed out again |

\* **only with the transaction guard** (1 below). Without it the harness reproduced acknowledged writes that never committed.
\* **revocation**: the bound held in every final trial, but one development run under default timeouts caught the isolated old leader answering a revoked token as valid **1.2 s after the revocation was sent**, 3 reads sent after its acknowledgement. Stale security reads are real, and that one stayed within the bound.

## What it found

### 1. A failed COMMIT poisons a pooled connection: acknowledged writes that never commit (fixed in the harness)

After a heal, writes through two members failed with `database is locked` for minutes while the third member's writes kept "succeeding". Those writes were acknowledged (HTTP 200) and visible only through that member's own connection; the other members never saw them. Cause: `go-dqlite`'s `Tx.Commit` turns only network and leadership errors into `driver.ErrBadConn`. A COMMIT that fails any other way can leave the transaction open on the leader (SQLite keeps a transaction open after a busy COMMIT), and `database/sql` puts the connection back in the pool. Every later statement on it then runs inside that open transaction, is acknowledged, never commits, and holds the leader's write lock against every other member.

The fix is in `cmd/ctl/store.go`: each transaction runs on a `sql.Conn` of its own, and on any failed COMMIT or ROLLBACK that connection is closed instead of returned to the pool. With it, every run passed "no lost acknowledged write"; the guard fired 34 times in the default run (`TX_GUARD=0` turns it off). The Go control service must do the same, and this should be reported upstream.

### 2. Without TLS, a member isolated mid-transaction blocks every write until the network heals

The first runs had peer TLS off. Isolating a follower stopped all writes on the majority (`database is locked`) for as long as the partition lasted, more than 2 minutes, and released 0.7 s after the heal. A transaction the isolated member had open on the leader held the write lock, and nothing noticed the connection was dead: dqlite's client heartbeat is a `TODO` in go-dqlite, and only go-dqlite's TLS path sets TCP keepalive (3 s, 3 probes) and `TCP_USER_TIMEOUT` on peer connections. With TLS on, the majority's write stall when a follower is isolated was 37 ms (default) and 162 ms (tuned). Peer TLS must be on, which the design wants anyway, and a member must not hold interactive transactions open across the network longer than it must.

### 3. How stale a read gets, and whether a revoked session stays valid

Every read goes to the leader, and a leader answers without checking it still leads. An old leader cut off from the majority keeps answering until it notices, which takes one to two election timeouts. Meanwhile the majority elects a leader and commits the revocation. In each trial the runner isolated the leader, revoked a session and a token through the majority, and asked the old leader about both every few milliseconds (6 pollers).

| | default (3 s) | tuned (300 ms) |
| --- | --- | --- |
| old leader's last answer after isolation | 3.5–5.7 s | 0.7–2.5 s |
| revocation acknowledged on the majority after isolation | 4.9–11.1 s | 2.5–4.6 s |
| longest the old leader said valid after the revocation was sent (final runs) | 0 ms (10 trials) | 0 ms (10 trials) |
| same, development run | **1,202 ms**, 3 reads sent after the ack answered valid | |
| stale answers on the majority, or anywhere after heal | 0 | 0 |
| isolated follower | never answers (reads go to the leader it can't reach) | same |

So the bound is the one the consistency model gives: **a revoked session or token can be accepted by an isolated old leader for up to about 2 × the election timeout after the majority commits the revocation**. That is 6 s at dqlite's defaults and 600 ms tuned. It happened in 1 of the 11 default-timeout leader partitions run with TLS, and in none of the 6 tuned ones. Usually the old leader steps down before the majority has even elected a new leader. A member's own read never proves ownership, which is why every claim above is a conditional write, and those were never fooled.

The other side of this is availability. While a leader is being replaced, reads fail on every member, so **auth checks fail** too: about 6 s per leader loss at default timeouts and about 0.6 s tuned.

### 4. Memory grows with the retained raft log, not with the database

With 50,000 sessions, 10,000 monitors and 5,000 tokens, the SQLite database itself is 11 MB. Writing 1M outbox rows and 1M history-export rows (1,000 batches of 1,000 + 1,000, expiry keeping the newest 20,000) never takes it past 25 MB, and `VACUUM` works (back to 8 MB). RSS is something else:

| stage | default RSS (n1) | default raft dir | tuned RSS (n1) | tuned raft dir |
| --- | --- | --- | --- | --- |
| start (after the fault phase) | 255 MB | 220 MB | 56 MB | 47 MB |
| seeded to control-plane size | 262 MB | 220 MB | 57 MB | 42 MB |
| 300k batch rows | 630 MB | 566 MB | 437 MB | 378 MB |
| 600k | 988 MB | 919 MB | 746 MB | 671 MB |
| 800k | 1,227 MB | 1,145 MB | 787 MB | 634 MB |
| 1M | 1,467 MB | 1,381 MB | 787 MB | 597 MB |
| expired, `VACUUM`, 30 s later | 1,497 MB | 1,398 MB | 787 MB | 614 MB |

dqlite keeps the trailing raft entries in memory as well as on disk. RSS ≈ database + trailing entries × entry size. With 8,192 trailing entries and these 1.2 MB batch transactions it had not levelled off at 1.5 GB, and would not before about 10 GB. With 512 it levels off at 790 MB from 600k on. Neither run meets the criterion as written (RSS at the end within 25% of RSS at 30% through), because the plateau comes late; the tuned run is bounded in fact. The batches here are far larger than Toposcope's real transactions (a monitor run is a few KB), so the real bound is much lower. But the service must set the snapshot parameters itself, keep each transaction small, and size memory as `trailing × largest routine transaction`. The default `trailing = 8192` is not safe to ship. Frequent snapshots have a cost: in the tuned run the leader's latencies were several times the follower's.

### 5. Failover is slower than the election, because timed-out connections stay in the pool

A query that hits its context deadline is not marked as a bad connection by go-dqlite, so `database/sql` keeps handing out connections to a dead or paused leader. After a leader `SIGKILL`, writes stopped for 6.4 s in the final default run, 13–21 s in earlier ones, and 0.6 s tuned. A lease takeover while the paused owner was also the dqlite leader took 37 s before the guard in 1 (which also closes those connections) and 3–6 s after. The control service needs short operation deadlines and has to drop a connection that times out.

### 6. Unexplained: `tls: bad record MAC`, and takeovers that stall

During pause and partition faults, members logged `proxy: … tls: bad record MAC` (1 in the default run, 9–20 in each tuned run). The connection is dropped and redialled, and no check failed because of it. But in 2 of the 12 tuned pause trials across runs, a takeover took 20 s, and once it did not happen within 90 s (the run stopped), with the MAC errors repeating every few seconds between two healthy members. This is a liveness failure with all three members up, and I have not found its cause. It may be go-dqlite's TLS proxy (it reaches into `tls.Conn` with `reflect`/`unsafe` to set socket options) or the short tuned timeouts. **This must be explained before HA ships.**

### 7. Contention: deferred transactions and checkpoints

Under 16 concurrent callers on the leader, the read-then-conditional-write allocator failed 94% of attempts with `database is locked` (a deferred transaction that read first cannot upgrade, and the busy timeout does not help), and autocommit inserts sometimes failed with `checkpoint in progress`. Nothing was wrong: refused attempts are refused. But the service should start write transactions as `BEGIN IMMEDIATE` (or make each claim one statement), serialise hot claims like the allocator in-process, and retry `checkpoint in progress`.

### 8. Backup and restore

`client.Dump` gave a consistent copy from the leader under full load in 42 ms (8.7 MB: database file, empty WAL). dqlite has no restore. The harness replays the dump table by table into a fresh cluster (14 s for 75k sessions, 10k monitors, 7.5k runs), and the row checksums match. A restore must also **fence what the backup cannot know**: positions and generations handed out after the dump. In the run, 45 arrival blocks were handed out after the dump; restored as-is, the allocator would have handed them out again. The harness moves the allocator on by 10¹² and every generation by 10⁶, and the restored cluster then reused nothing. `toposcope restore` must do the same.

### 9. Auth check over the Unix socket

Measured from Bun, the real caller, on a member with 50,000 sessions:

| | p50 | p95 | p99 |
| --- | --- | --- | --- |
| today: `bun:sqlite` in process, prepared query | 1.1 µs | 1.2 µs | 2 µs |
| Unix socket to Go, no database (the floor of any cache) | 118 µs | 185 µs | 396 µs |
| Unix socket to Go, dqlite read, on the leader | 264 µs | 462 µs | 1,013 µs |
| same, on a follower (forwarded to the leader) | 304 µs | 614 µs | 1,253 µs |
| 32 in flight from one Bun process, leader | 1.0 ms | 2.3 ms | 3.4 ms (27,400 checks/s) |
| Go in process, dqlite read (no socket), leader | 134 µs | 196 µs | 352 µs |

An auth check over the socket costs about 0.3 ms against about 1 µs today: 250 times slower, and still well under a millisecond per request. A cache is not needed for latency. Half the cost is the socket and HTTP framing, and a cache cannot go below that floor (0.12 ms). What a cache would actually buy is availability: auth keeps working through the seconds of an election (3 above). But it widens the staleness bound by its own lifetime, so the first release should go without one, then add a generation-voided cache only if elections prove disruptive.

### Write latency per operation

Inside the Go service, one caller, default configuration (µs):

| operation | via leader p50 / p95 / p99 | via follower p50 / p95 / p99 |
| --- | --- | --- |
| session check (read) | 134 / 196 / 352 | 119 / 214 / 372 |
| token check (read) | 141 / 207 / 400 | 129 / 233 / 402 |
| session create | 2,060 / 4,202 / 5,503 | 2,231 / 4,794 / 12,112 |
| session revoke | 1,546 / 3,337 / 7,847 | 1,630 / 3,321 / 4,785 |
| lease claim | 2,218 / 4,983 / 9,344 | 2,359 / 5,870 / 13,861 |
| lease renew | 1,483 / 3,597 / 8,900 | 1,903 / 3,774 / 5,933 |
| monitor run commit (5 writes) | 3,154 / 6,285 / 19,226 | 3,616 / 7,243 / 21,548 |
| block allocation | 1,735 / 3,961 / 10,128 | 1,893 / 3,571 / 6,464 |
| link advance | 1,818 / 3,573 / 7,979 | 4,064 / 18,281 / 29,628 |

With 16 callers on the leader: 22,100 session checks/s, 390 session creates/s, 156 monitor-run commits/s (p99 350 ms). That is plenty for a control plane, which commits a monitor run every few seconds rather than hundreds a second, but it means the scheduler must never put telemetry-rate work through dqlite.

### Fault timings (default run, then tuned)

| fault | default | tuned |
| --- | --- | --- |
| leader `SIGKILL`: new leader / write gap | 5.7 s / 6.4 s | 0.04 s / 0.6 s |
| leader isolated: revocation committed on majority | 4.9–11.1 s | 2.5–4.6 s |
| follower isolated: majority write stall | 37 ms | 162 ms |
| scheduler owner `SIGSTOP`ped: lease taken over | 3.1 s (×3) | 3.3 s, 20.3 s, 5.8 s |
| graceful restart of a follower / the leader: write gap | 275 / 63 ms | 183 / 102 ms |
| all three `SIGKILL`ed, then started: healthy after start | 5.2 s | 1.8 s |

## Recommendation

dqlite passes the part of the gate that would be hard to fix later: under leader loss, partitions, paused processes, restarts, total loss and restore, the conditional-write design held. Nothing was claimed twice, no position was reused, no stale owner wrote, and no acknowledged write was lost. A revoked session stayed acceptable on an isolated old leader only within the stated 2 × election timeout bound.

It does not yet pass as shipped software. Go ahead with step 2 (the Go boundary, standalone) on dqlite, since a single member is unaffected by every open problem here, with these as requirements of the control service from its first PR:

1. Each transaction on its own connection, closed on any failed COMMIT or ROLLBACK (1). Short deadlines, and a timed-out connection dropped (5). `BEGIN IMMEDIATE` for writes, and a retry on `checkpoint in progress` (7).
2. Peer TLS always on (2).
3. Snapshot parameters set explicitly and memory budgeted as `trailing × largest routine transaction` (4); no batch-sized transactions.
4. Election timeout well below the default (the tuned 300 ms gives a 600 ms revocation bound and sub-second failover), with the auth-check availability gap during elections stated in the failure contract (3).
5. `toposcope restore` replays and then fences allocator and generations (8).

Keep HA (step 5) gated on one more thing: the `bad record MAC` stalls (6) must be explained and fixed or worked around, and this harness must then pass, tuned, 50 pause trials in a row with no takeover over 10 s. If that cannot be done, the fallback in section 4 of the research (rqlite behind the same Go API) is the next thing to prove. The upstream reports to file are 1, 2 (client heartbeat), 5 and 6.
