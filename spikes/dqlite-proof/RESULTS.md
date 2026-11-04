# dqlite proof: results

Step 1 of the cluster design in [`docs/ha-research.md`](../../docs/ha-research.md) (branch `claude/ha-research-b67473`): a proof of dqlite before any Toposcope state moves to it. Nothing in `src/` changes.

**Verdict: dqlite does not pass the gate yet.**

**Update:** the same harness has now run against rqlite. See [`RESULTS-rqlite.md`](RESULTS-rqlite.md) for the results and the comparison.

- **Correctness held.** With the mitigations below enabled, no violation was observed in the tested control-plane operations: no duplicate claim, no reused identity, no stale owner's write, no lost acknowledged write, no partial monitor run.
- **Two things fail.**
  - **No bound on stale security reads.** An old leader that was paused while it was isolated answers revoked sessions as valid for about 2 × the election timeout after it resumes. Measured from the revocation's acknowledgement that was up to 6.4 s at default timeouts and 0.9 s tuned. A longer pause makes it longer, and dqlite's read path offers nothing to bound it.
  - **Takeovers stall.** When the leader is paused, the other two often go 8 s or more without electing a new one: up to 22 s, and once more than 80 s.
- **Not established here:** ClickHouse fencing, telemetry deduplication and recovery across both databases (there is no ClickHouse in the harness); host power loss; permanent loss of every node; amd64 behaviour (built and started only).

Earlier versions of this file overstated three things. "Safety passed" now means only the operations listed below. The "2 × election timeout" revocation bound was the consistency model's claim, not a measurement, and the new trials break it. The restore offsets did not give a safe identity scheme; restore incarnations (section 2) replace them.

## How to run

```bash
./run.sh            # default, tuned and budget, about 50 minutes
./run.sh stalls     # the paused-owner matrix, about 25 minutes
./run.sh <config>   # one of: default tuned budget stall-timeouts stall-snapshot stall-both stall-notls
```

Docker only; nothing is installed on the host. The image builds the dqlite C library from source (v1.18.7, raft bundled) with `go-dqlite` v3.0.4 for linux/arm64 and linux/amd64. Only arm64 has run the suite; the amd64 image builds, links and starts under emulation, which says nothing about its behaviour under faults. Each run writes `out/<config>/report.md`, `results.json`, the members' logs and every acknowledged write.

Three members (`n1`–`n3`) and a runner run in Compose on their own network, with no published port. The runner drives faults through the Docker socket: `SIGKILL`; `SIGSTOP`/`SIGCONT`; `iptables` inside a member for full and one-way partitions (the runner's own address is never cut, so it can keep asking an isolated member what it believes); CPU throttling; restarts; and loss of the whole cluster. For restores it creates fresh members (`f1`–`f3`) through the Docker API, two of them on the lost members' addresses.

| Path | What it is |
| --- | --- |
| `cmd/ctl` | a member: dqlite via `go-dqlite/app`, the operations, background workers, an HTTP API for the runner, a Unix socket for Bun, and a self-test of the transaction guard |
| `cmd/runner` | faults, workload, measurements, checks, report |
| `bench/auth.ts` | the Bun side of the auth-check benchmark |

### What is tested

Toposcope-shaped work runs throughout every fault, from all three members at once. Owners are adversarial: they write with the generation they remember and never check their own clock first.

- **Ownership:** a scheduler lease and a link-pull lease, each claimed by moving its generation on by one. Every owner write is conditional on its generation **and the installation's incarnation** still being current.
- **A monitor run as one transaction:** the run, its result, the monitor's state move and version, an outbox call with a stable id, and a pending history-export row.
- **Arrival blocks:** read `next`, then a conditional write of `next + 1000`.
- **A link position**, advanced by its owner.
- **Sessions and tokens**, created, revoked and checked through every member.

Acknowledgements are recorded in two places. Members append each write they acknowledge to a file, one `write(2)` per line, so the record survives `SIGKILL`. The runner, independently, records every session, revocation and arrival block it saw acknowledged (12,055 blocks in the default run). The checks compare both records with the database.

### Configurations

| config | election / heartbeat | raft snapshot | peer TLS | phases |
| --- | --- | --- | --- | --- |
| default | 3000 / 500 ms (dqlite's defaults) | every 1024, keep 8192 (go-dqlite's defaults) | on | guard, faults, latency, memory, backup |
| tuned | 300 / 30 ms | every 128, keep 512 | on | guard, faults, latency, memory |
| budget | 300 / 30 ms | every 128, keep 512 | on | realistic memory at the app container's 512 MB / 1 CPU |
| stall-* | one variable at a time | | | 15 paused-owner trials each |

Environment: one Mac (arm64, 8 CPUs) running Docker Desktop. All members share one kernel and one clock, the network is a bridge with sub-millisecond latency, and fsync costs are those of Docker Desktop's VM disk.

## Pass / fail

| Criterion | default | tuned | Evidence (default unless noted) |
| --- | --- | --- | --- |
| Guard: a failed COMMIT never poisons the pool | PASS | PASS | deterministic test, section 1 |
| No duplicate claims | PASS | PASS | 27 claims across 27 generations; none twice, no gaps |
| Stale owner's write refused | PASS | PASS | 3,025 committed runs, none with an older generation after a newer one or by a non-holder; 0 link advances by a non-owner; 6 writes by resumed paused owners under their old generation, all refused |
| No reused positions | PASS | PASS | 16,152 blocks (12,055 recorded at the runner): 0 overlaps, none past the allocator; 2,127 link advances, none repeated |
| No lost acknowledged write | PASS | PASS | 24,998 sessions, 4,871 revocations, 3,025 runs, 27 claims, 0 missing, through every fault below including all three `SIGKILL`ed at once |
| Monitor run is one transaction | PASS | PASS | 0 partial runs, 0 orphans, every version equals its run count |
| Lone member commits nothing and answers no revoked session | PASS | PASS | isolated follower: 0 of 5 writes, 0 of 28 reads answered |
| **Revocation visible everywhere within a bound** | **FAIL** | **FAIL** | section 3 |
| **Every lease takeover within 10 s** | PASS (3/3) | PASS (3/3) | the stall matrix fails it, section 5 |
| Memory bounded (oversized batches) | **FAIL** | **FAIL** | section 4 |
| Fits the app container (512 MB, 1 CPU, realistic work) | | PASS (budget) | peak 101 MB, flat across 60k monitor runs |
| Restore matches the backup (twice, same backup) | PASS | | row checksums of 11 tables equal, both times |
| No acknowledged write before the backup lost | PASS | | 3,069 runs (member record), 518 sessions and 254 blocks (runner record): none missing |
| No identity reused across restores of the same backup | PASS | | section 2 |
| An old member returning is fenced | PASS | | section 2 |

## What it found

### 1. A failed COMMIT poisons a pooled connection (fixed in the service, tested deterministically)

go-dqlite's `Tx.Commit` maps only network and leadership errors to `driver.ErrBadConn`. When COMMIT fails any other way, SQLite can keep the transaction open (it does after a deferred constraint violation or a busy COMMIT), and `database/sql` puts the connection back in the pool. Later statements on that connection are acknowledged, run inside the open transaction, never commit, and hold the leader's write lock against every other member. In the first runs this showed up as `database is locked` everywhere except on one member, whose writes "succeeded" and were invisible to the other members.

The guard (`cmd/ctl/store.go`) runs each transaction on its own `sql.Conn`, and on any failed COMMIT or ROLLBACK it calls `conn.Raw(func(any) error { return driver.ErrBadConn })`. `sql.Conn.Close()` alone would return the connection to the pool. `Raw` returning `ErrBadConn` makes `database/sql` call `releaseConn(ErrBadConn)`, which closes the driver connection (`database/sql` `Conn.Raw` → `closemuRUnlockCondReleaseConn` → `close` → `releaseConn`). Closing it is what makes the leader release the transaction.

The deterministic test (`cmd/ctl/guardtest.go`, the `guard` phase) uses a pool of exactly one connection, so the next request is guaranteed to get the same connection unless it was discarded. A deferred foreign-key violation makes COMMIT fail on demand:

| case | guard | next write on that pool | visible to another pool | after the pool closes | another writer |
| --- | --- | --- | --- | --- | --- |
| COMMIT fails (deferred FK) | off | acknowledged | **no** | **gone** (rolled back) | **blocked** (`context deadline exceeded`) |
| COMMIT fails (deferred FK) | on | acknowledged | yes | yes | proceeds |
| deadline passes before COMMIT | off / on | acknowledged | yes | yes | proceeds |

The deadline case is already safe: `database/sql` itself discards a transaction's connection when its context ends. Two limits remain. **A failed COMMIT can have an unknown outcome:** discarding the connection protects later operations, but it does not prove the transaction failed, so every operation that may be retried needs a stable identity (run ids and outbox call ids do here). And **go-dqlite's `Commit` ignores the caller's context** (it uses `context.Background()`), so a COMMIT in flight cannot be cancelled. It ends only when the leader answers or the connection dies.

### 2. Restore: a fresh incarnation, not offsets

The earlier fix (move the allocator on by 10¹², generations by 10⁶) was not an identity scheme. Restoring the same backup twice gives both restorations the same bumped counters.

Now every installation has an **incarnation**, a random 64-bit id in `cluster_meta`. A restore replays the dump and then writes a new incarnation, never the dump's. Every owner's conditional write and every allocation requires the incarnation to match. Run ids carry it, and acknowledged blocks and claims are recorded with it, so an identity is (incarnation, value). Existing rows keep their old identities. A member keeps the incarnation it belongs to in its data directory: a member with none (new, or deliberately wiped) adopts the installation's, and a member that remembers another one is **fenced**. It serves nothing, and its workers' writes, still carrying the old incarnation, are refused by the database.

Tested in the default run:

- **The same backup restored twice** onto fresh members, with work run on each restoration: 3 distinct incarnations; 6,271 blocks, none overlapping within an incarnation; 3,404 run ids and 33 claims, none repeated. 834 block ranges repeat as *numbers* across incarnations, which is expected: the namespace is what keeps them apart.
- **An old member returning.** The restored installation runs on two of the lost members' addresses, and lost member `n3` starts again with its old disk. Its go-dqlite driver found the restored installation's leader and connected: **dqlite has no notion of an installation identity**, so nothing below the application stops an old member from talking to a new cluster. The application fence did stop it. `n3` fenced itself and refused API writes, its workers' 49 allocation attempts under the old incarnation were refused by the database, and it acknowledged 0 writes. The restored installation's longest write gap meanwhile was 143 ms.
- **A race, found and fixed.** The replay first copied the dump's old incarnation, and one fresh member adopted it in the moment before the new one was written. Restore now skips `cluster_meta` and writes the new incarnation last.

**Consequences for the design.** Arrival positions restart their numbering per incarnation, so anything that orders by position (link feeds, dedupe keys) must key on (incarnation, position), and a link consumer that sees a new incarnation has to reconcile rather than resume. Rejoining a member to a restored installation is an explicit procedure: wipe its data, then join.

### 3. Stale security reads have no time bound

Every read goes to the leader, and a leader answers without first checking that it still leads. Each trial isolated the leader in one of five ways, revoked a session and a token through the majority, and polled the old leader with 6 pollers. The metric is the review's: from the revocation's **acknowledgement** to the last "valid" answer to a read sent after that acknowledgement. 3 trials per mode per config, 2 kinds each.

| mode | default (election 3 s) | tuned (300 ms) |
| --- | --- | --- |
| full partition | 0 ms | 0 ms |
| partition, old leader throttled to 5% of a CPU | 0 ms | 0 ms |
| old leader receives nothing from its peers (one-way) | **366 ms** (1 of 3 trials; 171 stale answers) | 0 ms |
| old leader can send nothing to its peers (one-way) | 0 ms | 0 ms |
| **old leader paused, partitioned, revocation acknowledged, then resumed still partitioned** | **3.2–6.4 s** (every trial; up to 2,755 stale answers) | **0.6–0.9 s** (every trial; up to 263) |

In the pause case the resumed old leader keeps answering as leader for about 2 × the election timeout **after it resumes**, however long it was paused. A pause longer than the time the majority needs to commit the revocation therefore extends the staleness one for one. Garbage collection, a stalled VM or a `SIGSTOP` can all do that. There is no wall-clock bound measured from the revocation, so "a revoked session is refused everywhere within X" cannot be promised from dqlite reads. The election timeout only sets the size of the window after the old leader resumes. No stale answer ever came from the majority, or from anyone after the partition healed.

What would bound it is a read that proves leadership: a quorum round before answering (Raft's read index) or a leader lease the read checks. go-dqlite exposes neither. The workaround inside dqlite is to make security checks writes, at about 2 ms and about 400 a second instead of 0.3 ms and over 25,000 a second (section 8). rqlite, the fallback named in the research, offers linearizable reads as a read level, which is a reason to put it through this harness.

The tuned 300 ms timeout is an experimental setting, not a recommendation. Election churn under load has not been measured.

### 4. Memory follows the retained raft log; realistic work fits the budget

dqlite keeps trailing raft entries in memory as well as on disk, so RSS is roughly the database plus the trailing entries times their size. Two runs:

- **Oversized batches** (1M outbox and 1M history rows in 1,000 transactions of 2,000 rows): the database never passes 26 MB, yet RSS reached 1,468 MB at default settings and was still growing. With 512 trailing entries it reached 780–790 MB by 600k rows and then went to 1,032 MB. These transactions are hundreds of times larger than Toposcope's, so this only shows the mechanism; it is not a budget.
- **The budget run:** realistic work held to the app container's real limits (`compose.yml`: 512 MB, 1 CPU), tuned settings. 50k sessions, 10k monitors and 5k tokens seeded in 1,000-row chunks, then 60,000 monitor runs (five rows each, from 16 callers), with a cleanup job deleting in 500-row transactions to keep 20,000 rows per table. That is 300,000 rows over many snapshot cycles. Peak RSS was **101 MB**, flat from 30k runs on (100 MB at 30k, 60k and after settling); the database was 21 MB, nothing was OOM-killed, and throughput was 150–263 runs/s at 1 CPU.

So the member fits, with room left for Bun in the same 512 MB, provided the service enforces three things: explicit snapshot parameters, a cap on transaction size, and chunked maintenance. go-dqlite's default `trailing = 8192` is not safe to ship. Bun's own memory in that container has not been measured here.

### 5. Takeover stalls: not TLS; leader pauses, made worse by frequent snapshots

The earlier report attributed improvement to "TLS". More precisely, go-dqlite's TLS path is the only one that sets **TCP keepalive and `TCP_USER_TIMEOUT`** on peer connections, and those liveness settings are what released a transaction stranded by a partitioned member. Encryption had nothing to do with it. Keepalive does not help when the member is paused rather than gone: a stopped process's kernel still acknowledges.

The stall matrix ran 15 paused-owner trials per config, changing one variable at a time. A trial pauses the scheduler owner, waits for a takeover, and lets go after 20 s if there is none. At 8 s it probes a write through each other member.

| config | election | snapshot | TLS | takeovers over 10 s | `bad record MAC` lines |
| --- | --- | --- | --- | --- | --- |
| stall-timeouts | 300 ms | default | on | 1 of 15 (21 s) | 23 |
| stall-snapshot | 3 s | 128 / 512 | on | **11 of 15** (11–22 s) | 52 |
| stall-both | 300 ms | 128 / 512 | on | 3 of 15 (11–13 s) | 38 |
| stall-notls | 300 ms | 128 / 512 | off | 2 of 15 (13 s, and none within 80 s) | 0 |
| default / tuned main runs | | | on | 0 of 3 / 0 of 3 | 28 / 5 |

What this shows:

- **TLS and the MAC errors are not the cause.** Stalls happen with TLS off and zero MAC errors. The MAC errors (dropped and redialled connections, only on the TLS path) are a separate, still unexplained fault worth reporting upstream.
- **The slow cases are almost all trials where the paused owner was also the dqlite leader.** At 8 s the other two members typically answered `no available dqlite leader server found`: they had not elected a new leader in more than 2 election timeouts, while a killed leader is replaced in 0.8–3.6 s.
- **Frequent snapshots make it much worse** (11 of 15 against 1 of 15 when only the timeouts change).
- With TLS off, a paused follower also produced `context deadline exceeded` on the others' writes, consistent with an open transaction it held on the leader.

The cause of the slow elections is not established. Candidates are the raft layer's handling of a peer that is alive at TCP level but silent, and snapshot work on the followers. That is the next thing to isolate, with dqlite's raft tracing on.

### 6. Failover and timed-out connections

A query that hits its deadline is not marked as a bad connection by go-dqlite, so `database/sql` keeps handing out connections to a dead or paused leader. The guard also discards those, since they surface as failed transactions. After a leader `SIGKILL`, writes stopped for 5.1 s at default timeouts and 1.4 s tuned.

### 7. Contention

Under 16 concurrent callers on the leader, the read-then-conditional-write allocator lost about 94% of its attempts to `database is locked`, because a deferred transaction that read first cannot upgrade to a write and the busy timeout does not help. Autocommit inserts sometimes failed with `checkpoint in progress`. Nothing incorrect was committed. The service should use `BEGIN IMMEDIATE` (or single-statement claims), serialise hot claims in-process, and retry `checkpoint in progress`.

### 8. Auth check over the Unix socket

Measured from Bun with 50,000 sessions, default run, on the leader:

| | p50 | p95 | p99 |
| --- | --- | --- | --- |
| today: `bun:sqlite` in process | 1.1 µs | 5 µs | 8 µs |
| Unix socket, no database (the floor of any cache) | 132 µs | 234 µs | 846 µs |
| Unix socket, dqlite read | 284 µs | 739 µs | 1,645 µs |
| same from a follower | 301 µs | 415 µs | 927 µs |
| 32 in flight from one Bun process | 0.97 ms | 2.7 ms | 4.5 ms (26,400 checks/s) |
| Go in process, dqlite read, no socket | 119 µs | 157 µs | 195 µs |

There is no performance case for an auth cache. A cache would not fix section 3 either: it adds its own lifetime to the staleness.

### Write latency (Go service, one caller, default run, µs)

| operation | via leader p50 / p95 / p99 | via follower p50 / p95 / p99 |
| --- | --- | --- |
| session check | 119 / 157 / 195 | 172 / 391 / 927 |
| session create | 1,677 / 3,310 / 4,189 | 1,903 / 4,189 / 9,627 |
| session revoke | 1,630 / 3,618 / 6,793 | 1,673 / 3,275 / 6,763 |
| lease claim | 2,393 / 5,154 / 12,398 | 2,278 / 4,563 / 11,854 |
| lease renew | 1,670 / 3,315 / 6,743 | 1,756 / 3,596 / 8,624 |
| monitor run commit (5 writes) | 2,839 / 5,876 / 12,852 | 2,755 / 5,739 / 16,995 |
| block allocation | 1,892 / 4,219 / 11,408 | 2,003 / 4,251 / 10,616 |
| link advance | 1,852 / 3,354 / 7,643 | 3,506 / 10,994 / 15,421 |

With 16 callers on the leader: 38,700 session checks/s, 390 session creates/s, 237 monitor-run commits/s.

### Fault timings (default / tuned)

| fault | default | tuned |
| --- | --- | --- |
| leader `SIGKILL`: new leader / write gap | 3.6 s / 5.1 s | 0.8 s / 1.4 s |
| follower isolated: majority write stall | 52 ms | 177 ms |
| scheduler owner paused (follower): takeover | 3.0–3.1 s | 3.0–3.1 s |
| graceful restart, follower / leader: write gap | 48 / 63 ms | 269 / 211 ms |
| all three `SIGKILL`ed, then started: healthy after start | 6.4 s | 2.3 s |

"All three `SIGKILL`ed" tests restart recovery from intact disks. It is not a test of host power loss (the page cache survives a process kill) or of losing every disk, which only a restore covers.

## Recommendation

| Work | Decision |
| --- | --- |
| Go operation API, generated types, service skeleton | Proceed: storage-neutral |
| Transaction guard, restore incarnations, chunked maintenance, explicit snapshot settings | Done in the harness; required in the service whatever the database |
| Root-cause the election stalls with a paused leader (raft tracing; snapshot interaction) | Inside the proof gate, time-boxed |
| A read that proves leadership for security checks | Inside the proof gate: not available in go-dqlite today |
| The same harness against rqlite (linearizable reads; no interactive transactions) | Next, in parallel with the two items above |
| Move production domains onto dqlite | Hold |
| Ship clustered HA | Hold |

dqlite's write path did everything the design asks of it once the service guards its connections and fences restores. Its read path cannot bound how long a revoked session stays acceptable on a paused old leader, and a paused leader can stall takeover far beyond the election timeout. Those are the two conditions for passing the gate. If a time-boxed investigation cannot fix both, rqlite run through this same harness is the comparison to make. Its lack of interactive transactions is the cost to weigh: every multi-row operation above would have to become a single conditional batch.

Upstream reports to file: the failed-COMMIT connection reuse (1), `Commit` ignoring the caller's context (1), no client heartbeat or keepalive off the TLS path (5), the `bad record MAC` errors (5), and slow elections with a paused leader (5).
