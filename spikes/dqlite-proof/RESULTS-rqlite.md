# rqlite proof: results, and the comparison with dqlite

The same harness as [`RESULTS.md`](RESULTS.md) (dqlite), run against rqlite v10.6.6: the same operations, workload, fault injection, independent acknowledgement records, resource limits and acceptance criteria. Only the storage layer differs: `cmd/ctlr` (a member that supervises a local `rqlited` and talks to it over HTTP) in place of `cmd/ctl` (dqlite embedded through go-dqlite). Nothing in `src/` changes.

**Verdict: rqlite is the preferred backend, and the dqlite investigation stops for this release. The HA gate is not passed with stock rqlite; a two-part patch to hashicorp/raft passes the targeted test (section 5), and is not yet upstream or reviewed.** **Production HA is parked for this release** (section 7): the patch goes upstream rather than into a fork, and the release ships single-node with tested backup and restore.

rqlite passed both requirements dqlite failed: fresh authorization reads and prompt takeovers. It did that with workable conditional operations and a much better memory profile. Two problems remain:

- **The snapshot-install stall is a blocker in stock rqlite, and it reproduces at default settings.** The targeted reproducer (rq-snapstall, section 5) lost the leader while a lagging follower was confirmed to be installing a snapshot, and never healed the partition. The two members that could still talk to each other committed nothing for **154–158 s** when the leader's inbound traffic was cut (5 of 5 trials) or the leader was killed (5 of 5), and **not within 300 s** when it was paused (4 of 4). In every trial the follower's Raft main loop was blocked reading the snapshot stream, so it could not vote. No acknowledged write was lost.
- **A patched hashicorp/raft fixes it in this test.** The patch is [`patches/raft-snapshot-idle-timeout.patch`](patches/raft-snapshot-idle-timeout.patch), and the same rqlite version is built against it. It makes two changes. A follower now abandons a snapshot stream that delivers nothing for 5 s. A candidate sent a snapshot by the leader of its own term now becomes its follower, as it already did for AppendEntries; the second change was needed once the first let the install return. With the patch, all 30 reproducer trials (10 per mode) committed again within **5.8–9.6 s** without healing, and no acknowledged write was lost. The regression runs pass as before.
- **A member from a lost installation took over a restored cluster** that reused its peers' addresses, overwriting the restored data. A fresh trust boundary on disaster restore (new node CA, mutual TLS) kept it out in every trial. Whether hashicorp/raft should reject such a leader by itself, or the restore procedure must exclude it, is for upstream to judge (section 3).

**Not established here** (as for dqlite): ClickHouse fencing and recovery across both databases; host power loss; losing every disk; amd64 under faults (only arm64 ran); real network latency (one host, bridge network); real disks (Docker Desktop's VM disk, so write latencies are not a durability comparison).

## How to run

```bash
./run.sh rqlite      # rq-default, rq-restore, rq-snap, rq-budget (about 35 minutes)
./run.sh rq-stalls   # rq-asym, rq-asym-snap, and the paused-owner matrix (about 30 minutes)
./run.sh rq-snapstall # the stall reproducer, stock rqlite (about 45 minutes)
./run.sh rq-fix      # the reproducer, rq-default and rq-asym-snap on the patched raft (about 70 minutes)
./run.sh <config>    # any one config
```

The image now carries both members. `rqlited` comes from the v10.6.6 release tarball for the target architecture, `rqlited-patched` is the same version built against the patched raft (section 5), and `ctlr` is built beside `ctl`. `rq-default` gives every installation the same node certificate, as the dqlite runs do (`MTLS=0`). Every other rqlite config gives each installation its own certificate authority and requires client certificates (`MTLS=1`, section 3).

| config | rqlited flags | phases |
| --- | --- | --- |
| rq-default | defaults: election 1 s, heartbeat 1 s, snapshot at 8192 entries or a 4 MB WAL; shared certificate | batch, faults, latency, memory, backup |
| rq-restore | defaults; a CA per installation | backup (restore twice, old member returns) |
| rq-snap | `-raft-snap 128 -raft-snap-int 1s -raft-snap-wal-size 262144`; a CA per installation | faults, backup |
| rq-budget | as rq-snap, members limited to 512 MB and 1 CPU, a Bun auth client running in each | budget |
| rq-asym / rq-asym-snap | defaults / frequent snapshots | faults, one-way partitions only, 15 trials per direction |
| rq-stall-default, -snapshot, -fast, -notls | defaults; frequent snapshots; heartbeat, election and leader lease all 300 ms plus frequent snapshots; frequent snapshots with peer TLS off | 15 paused-owner trials each |

Revocation trials: 6 per mode in rq-default and rq-snap (5 modes, session and token), 15 per direction in the asymmetric configs. Election timeouts in the criteria are taken as 1 s (300 ms for rq-stall-fast).

## How the operations map

rqlite has no interactive transactions. Each operation that changes several rows is **one request** of statements sent with `?transaction`, which applies all of them or none. That alone is not a conditional write, because an `UPDATE` that matches no row is not an error. So every precondition is an assertion:

```sql
INSERT INTO must (ok, why) VALUES ((<condition>), 'stale')
```

`must` is a view whose `INSTEAD OF` triggers `RAISE(ABORT, …)` when `ok` is false. That fails the statement and rolls the whole request back. `changes()` after an `UPDATE` asserts that it matched. A monitor run, for example, is: assert the run id is new; assert the lease generation, owner and incarnation; insert the run and its result; update the monitor's state; assert that one row changed; insert the outbox call and the history-export row. Every value that differs between members (time, random ids) is computed in Go and passed as an argument, because rqlite replicates statements, not pages.

**Operation ids.** A request whose outcome is unknown (timeout, lost leadership, no leader) is repeated with the same statements until it answers or its deadline passes. Nothing rqlite executed and refused is retried. Repeats are safe by construction:

- A monitor run's id is its operation id. A repeat that finds its own run (same generation, owner and incarnation) answers done.
- A link advance stores its operation id on the row. A repeat answers the position it set and does not move it again.
- A session create treats a duplicate key on a repeat as success.
- An allocation repeated after an unknown outcome may allocate a second block. The first becomes a gap, never an overlap: 30 such gaps in 31,218 blocks in rq-default.
- A claim repeated the same way may move the generation on twice, both times to the same owner, which then uses the second.

Ownership reads and every security check are `linearizable`. Queued writes are not used. Nothing falls back to a weaker read.

The cost compared with dqlite's interactive transactions is real but small. Each operation is a list of statements written once, with its preconditions stated as assertions, instead of a read-then-write in Go. There is no transaction guard, no `BEGIN IMMEDIATE`, no connection pool to poison and no lock contention: 16 concurrent allocators lost nothing, against about 94% `database is locked` on dqlite. There is one footgun: **a batch sent without `?transaction` carries on after a failed statement** and commits the rest. The client wrapper sets it for every multi-statement request, and the batch test below shows what happens without it.

## Pass / fail

| Criterion | rqlite | dqlite (RESULTS.md) | Evidence (rq-default unless noted) |
| --- | --- | --- | --- |
| Conditional batches: refusals leave no trace, ids apply once, failures midway undo everything | PASS (13 cases) | n/a (interactive transactions; the guard test instead) | section 1 |
| No duplicate claims | PASS | PASS | 46 claims across 46 generations |
| Stale owner's write refused | PASS | PASS | 2,842 runs, 0 by a non-holder; 6 old-generation writes by resumed paused owners, all refused |
| No reused positions | PASS | PASS | 31,218 blocks (22,042 recorded at the runner), 0 overlaps; 1,964 link advances, none repeated |
| No lost acknowledged write | PASS | PASS | 22,065 sessions, 4,237 revocations, 2,840 runs, 46 claims, 0 missing, through every fault including all three `SIGKILL`ed |
| Monitor run is one transaction | PASS | PASS | 0 partial runs, 0 orphans |
| Members' own copies identical (statement replication is deterministic) | PASS | n/a | per-table checksums read locally on each member, equal in every run |
| **No check begun after a revocation's ack answers valid** | **PASS** (none observed) | **FAIL** (up to 6.4 s) | no stale authorization observed in 360 tested revocations (180 isolations), section 2 |
| Revocation visible everywhere within 2 × election timeout | PASS | FAIL | 0 ms in every trial |
| Lone member commits nothing, answers no revoked session | PASS | PASS | 0 of 1,136 reads answered, 0 of 5 writes |
| **Every lease takeover within 10 s** | **PASS** (60 of 60 in the stall matrix) | **FAIL** (17 of 60) | section 4 |
| **The majority commits during every isolation** | stock rqlite: **FAIL, blocker**: at defaults, losing the leader during a confirmed snapshot install stalled the other two for 154–158 s (asym-in 5/5, kill 5/5) and past 300 s (pause 4/4), without heal. **Patched raft: PASS**, 30 of 30 within 10 s (worst 9.6 s), and 0 of 60 asym trials stalled with frequent snapshots | not measured (the revocation always committed) | section 5, rq-snapstall, rq-snapstall-fix, rq-asym-snap-fix |
| Memory bounded (oversized batches) | PASS: 205–220 MB peak at defaults | FAIL: 1,468 MB and growing | section 6 |
| Fits the app container (512 MB, 1 CPU) | PASS: 91 MB for Go and rqlited; 214 MB cgroup peak with Bun running | PASS: 101 MB (Bun not measured) | section 6 |
| Restore matches the backup (twice) | PASS | PASS | row checksums of 11 tables |
| No acknowledged write before the backup lost | PASS | PASS | 2,886 runs, 568 sessions, 568 blocks |
| No identity reused across restores | PASS | PASS | 3 incarnations; 12,889 blocks, 3,054 run ids, 52 claims, none repeated within an incarnation |
| **An old member returning is kept out** | **FAIL** with a shared certificate; **PASS** with fresh cluster credentials on restore | PASS (fenced in the application) | section 3 |

## What it found

### 1. Conditional batches do what the operations need

`/selftest/batch` runs against the live cluster before the faults. Each case records a footprint of every row it could touch, before and after:

| case | expected | result |
| --- | --- | --- |
| monitor run with an old generation | refused, no trace | PASS |
| monitor run with a wrong incarnation | refused, no trace | PASS |
| monitor run by the current owner | run, result, state, call and history all applied | PASS |
| the same run id again, as a new request | refused as a duplicate, applied once | PASS |
| the same run id again, as a repeat after an unknown outcome | answered done, applied once | PASS |
| failure midway: monitor missing (statement 6 of 8) | nothing applied | PASS |
| failure midway: outbox call id taken (statement 7 of 8) | nothing applied | PASS |
| claim of a held lease | refused, generation and claims unchanged | PASS |
| allocation with a wrong incarnation | refused, allocator unchanged | PASS |
| link advance with an old generation | refused, position unchanged | PASS |
| link advance, then the same operation id again | moved once; the repeat answers the same position | PASS |
| **the refused stale run, sent without `?transaction`** | reproduces the footgun | the stale run, its result, state move, call and history **all committed** |

The assertion triggers use one trigger per fixed reason. `RAISE` with a computed message needs SQLite 3.48, and the system SQLite that opens a backup file is older. The first full run caught that: the backup could not be opened.

### 2. Security reads are fresh

Same five isolation modes as for dqlite, 6 trials each in rq-default and in rq-snap, plus 15 per direction in rq-asym and in each of three rq-asym-snap runs. That is 180 isolations, each revoking a session and a token, with 6 readers polling the old leader.

- **No stale authorization was observed in 360 tested revocations**: no check begun after a revocation's acknowledgement answered valid, on any member, in any trial. That includes `pause+partition`, where dqlite's resumed old leader answered stale for 3.2–6.4 s. A linearizable read on an isolated or resumed old leader cannot reach a quorum, so it fails. The old leader stopped answering 350–900 ms after being cut off; the read timeout bounds that, not staleness.
- Not one stale answer on the majority, or anywhere after heal.
- Cost: an auth check from Bun over the Unix socket, through Go, as a linearizable read on the leader, takes p50 332 µs, p95 577 µs, p99 1.3 ms. From a follower it is p50 434 µs. From one Bun process with 32 in flight: 19,400 checks/s. dqlite's non-proving read took p50 284 µs and reached 26,400/s. The floor (socket ping, no database) is about 150 µs. The linearizable read itself costs about 190 µs inside Go (session check p50 188 µs on the leader), against 119 µs for dqlite's local read.

### 3. A lost installation's member took over a restored cluster

The restore test loses n1–n3, restores the same backup twice onto fresh members f1–f3 (f1 and f2 on n1's and n2's addresses), and then starts the lost n3 again with its old disk.

**With one certificate shared across installations (rq-default)**, n3 came back with a higher Raft term. f1 and f2 rejected its pre-votes ("node is not in configuration"), yet then **accepted it as leader and installed its snapshot**: `node n3 at 10.213.7.13:4002 is now Leader`, then `initiating node restore`. The restored installation's data on f1 and f2 was replaced by the lost installation's data, and their configuration by n3's. The application fence then fenced f1 and f2 themselves, because they now saw the old incarnation. n3 was not fenced, since the data it read was its own, and it acknowledged 756 writes. f3 was stranded. The restored cluster stopped writing (17.8 s until the test killed n3) and was left with no usable configuration. In this run, Raft rejected the old member's votes for not being in the configuration but accepted its `AppendEntries` and `InstallSnapshot` as leader. Reusing peer addresses while old state can return may be a restore-procedure problem as much as a library one, so the upstream report states the reproduction and the expected behaviour without claiming a defect.

dqlite in the same test let n3's client reach the restored leader. Its Raft did not adopt n3, and the application fence held.

**With fresh cluster credentials (a new node CA and `-node-verify-client`; rq-restore and rq-snap)**, n3 could not open a connection to anyone. It acknowledged 0 writes, its API refused writes, and the restored cluster's longest write gap was 127 ms (rq-restore) and 1.7 s (rq-snap).

The procedure keeps two protections, at two levels:

- **Fresh cluster credentials and membership on disaster restore.** Old members are rejected before they can take part in Raft. rqlite's node mutual TLS is off unless explicitly enabled, and changing the CA means restarting the nodes so they load the new trust configuration. That is acceptable for a disaster restore, where every member is new. An ordinary member restart or replacement within an installation keeps the installation's CA and does not regenerate it.
- **A fresh application incarnation.** Obsolete operations are refused and no identity is reused, as for dqlite.

### 4. Takeovers are prompt, including a paused leader

The paused-owner matrix, 15 trials per config, is the one that failed dqlite.

| config | trials where the paused owner was also the Raft leader | takeover (min–max) | longest write gap |
| --- | --- | --- | --- |
| rq-stall-default | 8 of 15 | 3.1–3.5 s | 2.6 s |
| rq-stall-snapshot | 6 of 15 | 3.0–3.5 s | 2.2 s |
| rq-stall-fast (300 ms timeouts) | 10 of 15 | 3.0–3.4 s | 1.1 s |
| rq-stall-notls | 9 of 15 | 3.0–4.4 s | 3.1 s |

All 60 took over within 4.4 s, against 17 of 60 over 10 s for dqlite. The 3 s floor is the lease TTL. The pause is of the whole member: `SIGSTOP` of both `rqlited` and `ctlr`.

Other fault timings (rq-default / rq-snap): after a leader `SIGKILL`, a new leader in 1.5 / 0.7 s and a write gap of 2.1 / 1.3 s. An isolated follower stalled the majority's writes for 150 / 49 ms. Graceful restarts gave write gaps of 50–100 ms. With all three `SIGKILL`ed, the cluster was healthy 1.8 / 2.6 s after start.

### 5. Losing the leader during snapshot catch-up stalls the majority

With frequent snapshots (`-raft-snap 128`), a trial that drops everything the leader **receives** (asym-in) sometimes left the other two unable to commit anything. The runner gives up after 2 minutes, saves goroutine dumps, and heals.

| config | asym-in trials | asym-out trials | majority never committed in 2 min |
| --- | --- | --- | --- |
| rq-default + rq-asym (defaults) | 6 + 15 | 6 + 15 | 0 of 42 |
| frequent snapshots: rq-snap (two runs) + rq-asym-snap (three runs) | 6 + 6 + 45 | 0 + 6 + 45 | **5 of 57 asym-in**, 0 of 51 asym-out; 4 more asym-in trials committed only after 12–33 s |

All four failures with diagnostics show the same thing. The dumps land in `out/<config>/diag/`, which is not committed; one is kept in [`evidence/`](evidence/). In the first, the old leader n2 could send but not receive. Follower n3 had fallen behind and was receiving a snapshot from n2. Its goroutine dump shows Raft's **main loop** blocked for 2 minutes reading the snapshot stream from n2:

```
goroutine 50 [IO wait, 2 minutes]:
crypto/tls.(*Conn).Read ...
github.com/hashicorp/raft.(*countingReader).Read     progress.go:106
io.Copy
github.com/hashicorp/raft.(*Raft).installSnapshot     raft.go:1909
github.com/hashicorp/raft.(*Raft).processRPC          raft.go:1422
github.com/hashicorp/raft.(*Raft).runFollower         raft.go:172
```
 That stream stalls because n2 never gets n3's TCP acknowledgements, and the read has no deadline. While blocked there, n3 cannot time out, vote or stand for election. Its status said follower of n2, last contact 2 minutes ago. n1 stood for election alone, so there was no quorum. Healing restored service in 1.8 s; the write gap was 128 s. The reproducer below measures how long it lasts without the heal.

The ingredients are a lagging follower that needs a snapshot, a transfer in progress, and a leader that can send but not receive. rqlite's defaults snapshot 64 times less often, so the overlap is rarer, and it was not reproduced in 42 trials. Rarer is not prevented, and the targeted reproducer below confirms it: once the overlap occurs, the stall happens at default settings too. **This is a blocker for the HA guarantee.**

#### The targeted reproducer, at default settings

`./run.sh rq-snapstall` (`cmd/runner/snapstall.go`) creates the overlap deliberately, at rqlite's defaults (snapshot every 8,192 entries, 10,240 trailing logs, 10 s transport timeout) with mutual TLS. The database is seeded with 50k sessions, 10k monitors and 5k tokens, so a snapshot is several MB. Each trial:

1. Cuts follower F off and writes until the leader L's last snapshot is past F's last entry plus the 10,240 trailing logs, so F can only catch up from a snapshot (20,000–30,000 writes).
2. Slows L → F to 2 Mbit/s (tc), lets F back, and waits until F's goroutine dump shows `raft.(*Raft).installSnapshot` (0.2–1.2 s in every trial).
3. Takes L out by one of three modes, starting writes on F and the other follower O:
   - **asym-in** drops everything L receives, so L can still send;
   - **pause** `SIGSTOP`s L's processes, while its kernel still answers TCP;
   - **kill** `SIGKILL`s L's container, which was meant as the control.
4. Probes writes through O and F every 250 ms, **without healing**, for up to 300 s.
5. Heals, then checks every acknowledged write is present.

| mode | trials during a confirmed install | majority's first write after the cut | write gap | acknowledged writes missing |
| --- | --- | --- | --- | --- |
| asym-in | 5 | 154.4–157.9 s | 153.9–157.7 s | 0 |
| pause | 4 | **none within 300 s** | 300.9–301.8 s (the cap) | 0 |
| kill | 5 | 154.5–156.1 s | 153.7–156.1 s | 0 |

At 10 s and 60 s after the cut, in every trial, F reported itself a follower of the lost leader and was still inside `installSnapshot`, while O stood for election alone as a candidate. The goroutine dumps (in `out/`, not committed) show F's main loop in the same frames as the dump above: `countingReader.Read` under `io.Copy` in `installSnapshot`. Once the partition healed, every trial was healthy again within 0.6–2.3 s.

**What bounds the 155 s is not established.** Earlier versions of this section credited the leader's snapshot-send deadline. The kill trials rule that out, because the sender was dead and the stall lasted just as long. One explanation fits all three modes but has not been tested: TCP keepalive on F's end of the stream. Go enables it by default, and 15 s idle plus 9 unanswered probes at 15 s is about 150 s. When L's kernel is gone (kill), or L's inbound traffic is dropped (asym-in), the probes go unanswered and the connection fails. A paused process's kernel still acknowledges them, so the read never ends. Whatever the mechanism, it is an accident of the transport, not a recovery bound anyone set: a 155 s gap is far past the 10 s target, and a paused or half-alive leader makes it unbounded.

The planned run was 5 trials per mode in one go. It stopped after the fourth pause trial, when the host machine went to sleep and the containers disappeared. Those 9 trials are kept from that run's log. The 5 kill trials were run afterwards on a fresh cluster (`SNAPSTALL_MODES=kill`). An earlier smoke run (asym-in, 1 trial) stalled for 157 s.

**Conclusion: default snapshot settings are not a workaround.** The stall needs only a lagging follower, an install in progress and a lost leader, and it then lasts at least about 155 s whichever way the leader is lost. The fix has to be shown working by this reproducer, holding writes within 10 s in all three modes. The candidates are:

- a receive deadline on the snapshot stream (or one that resets per chunk), with the cleanup that follows it: abort the install, discard the partial snapshot and resume elections;
- installing the snapshot off Raft's main loop, so the follower can still time out and vote;
- a bounded, tested recovery mechanism outside Raft.

Each has to be demonstrated, and the first two are changes in hashicorp/raft or a fork of it.

#### The fix, demonstrated

[`patches/raft-snapshot-idle-timeout.patch`](patches/raft-snapshot-idle-timeout.patch) applies to hashicorp/raft v1.8.0. The image builds rqlite v10.6.6 from source against it, with the same Go and SQLite as the release binary, and installs it as `rqlited-patched` beside the release `rqlited`. `RQLITED=rqlited-patched` selects it, and `./run.sh rq-fix` runs everything below.

1. **An idle deadline on the incoming snapshot stream** (`net_transport.go`). Before each read of the stream, the follower sets a read deadline 5 s ahead (`NetworkTransportConfig.SnapshotIdleTimeout`, default 5 s). A stream that is still delivering is never cut, however slow the whole transfer is; a stream that goes quiet fails its next read. Raft's existing error path then runs: the partial snapshot is cancelled (`sink.Cancel()`) and the RPC answered with the error. The failure is sticky, so Raft's drain of the rest of the stream returns at once instead of waiting again. Unread snapshot bytes are left on that connection, so it is closed after the response is sent, and the leader opens a new one if it is still there. A complete stream clears the deadline and the connection is reused as before.
2. **A same-term candidate steps down on InstallSnapshot** (`raft.go`). With only the first change, 1 of 5 kill trials still stalled past 300 s, for a different reason. The lagging follower had become a candidate while it was cut off; pre-vote kept its term unchanged. When the leader's snapshot arrived at that same term, `installSnapshot` recorded the leader but left the follower a candidate: it steps down only for a higher term, where `appendEntries` also steps down at the same term. After abandoning the install, the follower was a candidate that still recorded the lost leader. It refused the other member's pre-votes "since we have a leader", and as a candidate it never cleared that leader. The other member refused its pre-votes in turn, because the follower's log was behind. No election could succeed. The patch applies `appendEntries`' rule to `installSnapshot`.

Both changes come with unit tests in the patch. The stalled stream is abandoned after the idle time and its connection closed, while a complete stream keeps its connection. A same-term candidate becomes a follower; this test fails without change 2. Raft's whole suite was run on both versions, 30 times for its timing-sensitive tests. It fails the same tests at similar rates with or without the patch (`TestRaft_HasExistingState`, `TestRaft_ProtocolVersion_Upgrade_2_3`, `TestNetworkTransport_AppendEntriesPipeline_CloseStreams`), plus `TestFileSS_BadPerm`, which cannot pass as root in a container.

**rq-snapstall-fix** (defaults, a CA per installation, 10 trials per mode, the same reproducer):

| mode | trials during a confirmed install | majority's first write after the cut | write gap | acknowledged writes missing |
| --- | --- | --- | --- | --- |
| asym-in | 10 | 5.8–8.1 s | 5.1–7.8 s | 0 |
| pause | 10 | 5.8–9.6 s | 5.5–9.4 s | 0 |
| kill | 10 | 6.2–9.0 s | 5.3–9.0 s | 0 |

At 10 s, every lagging follower was a follower of a new leader, and none was still installing.

**Regression, with the patched binary:**
- **rq-default-fix:** passes the same 30 checks as rq-default. The 31st, an old member returning, fails as it does in rq-default, because that config shares one certificate across installations. That includes 60 revocation trials with no stale authorization observed, the 13 batch cases, 3 paused-owner takeovers (3.1–4.3 s), memory and two restores.
- **rq-asym-snap-fix:** frequent snapshots, 15 trials per direction. 0 of 60 isolations stalled, against 5 of 57 asym-in trials with stock rqlite; the longest write gap was 7.5 s.
- **Latency (rq-lat against rq-lat-fix):** the latency phase was run back to back with each binary. There was no systematic difference: single-caller medians for checks were 82–141 µs against 85–135 µs, and for writes 2.8–3.3 ms against 2.8–3.4 ms, with each binary faster on some operations. The host was slower than in the earlier rq-default run on both. This is expected, since the patch touches only the snapshot path and the step-down rule. The Bun socket benchmark was not run back to back. In rq-default-fix, its single caller was faster than in rq-default (p50 191 µs against 332 µs), and 32 in flight was slower (p50 4.1 ms against 1.3 ms). That is inconclusive until it is repeated with both binaries in one session.

**Limits of this result:**
- **10 s was a test target, not a product requirement.** The worst trial took 9.6 s: the 5 s idle deadline plus an election at rqlite's 1 s timeouts. The larger cost is not that margin. It is owning an unreviewed consensus patch and carrying it through upgrades.
- **The patch is ours, not upstream's.** Shipping it means carrying a fork of hashicorp/raft and building rqlite from source until upstream takes an equivalent change.
- **An earlier run with the patch is excluded.** In it, the harness's pause matched processes named `rqlited` only, so it never paused `rqlited-patched`, and those pause trials did not pause the leader. The harness now matches both names; every pause trial above is from after that fix.
- **Not tested:** snapshots large enough for a slow real link to go quiet for 5 s mid-transfer; amd64.

The first rq-snap run stopped at its failure, before any asym-out trial; its report was overwritten by the second run, so only this text records it. rq-asym-snap was run three times by hand (`out/rq-asym-snap-1` to `-3`). Run 1 predates a harness fix, so its "within bound" check reads a meaningless window for its one never-committed revocation; its stale-read counts are unaffected.

### 6. Memory: bounded, and the budget holds with Bun counted

Memory here is **both processes**: `ctlr` and `rqlited` RSS summed. The cgroup figures are the whole container and include page cache.

- **Oversized batches** (1,000 requests of 2,000 rows, as for dqlite; rq-default): the storage side peaked at **220 MB** and moved in a sawtooth with snapshots (130–250 MB on the leader, 70–100 MB on followers). It ended at 72–122 MB, below where it was at 30% of the run. dqlite reached 1,468 MB and was still growing. Here RSS did not grow with the retained log; why rqlite differs was not investigated.
- **Budget** (rq-budget): each member limited to 512 MB and 1 CPU. 50k sessions, 10k monitors and 5k tokens seeded, then 60,000 monitor runs from 16 callers with chunked cleanup, while **a Bun process in each member made auth calls throughout** (8 in flight, about 60,000 checks each, none failed). Go plus rqlited peaked at **91 MB** and stayed level (n1 64 → 63 MB, n2 74 → 86 MB, n3 60 → 62 MB from 20k to 60k runs). The Bun client used 62 MB. The whole container peaked at 214 MB of cgroup memory, page cache included. Nothing was OOM-killed. At 1 CPU, monitor-run commits ran at 440–1,190/s (p99 120–310 ms), against 150–263/s for dqlite.

The real Bun application, not this auth client, is what has to fit in the rest. That has still not been measured.

### 7. Decisions

| Decision | Status |
| --- | --- |
| Publish both harnesses and their results for review | Yes |
| Prefer rqlite and stop dqlite work for this release | Yes |
| Continue the Go domain API where it serves the architecture | Yes, but a production database migration is not a prerequisite for it |
| Ship production HA in this release | **No, parked** unless a current customer or firm commitment requires it; the release ships single-node with tested backup and restore |
| Claim the complete HA gate has passed | **No** (the stall is fixed only in a patched raft, not yet reviewed or upstream) |
| Treat default snapshot settings as a proven workaround for the stall | **No** |
| Carry the raft patch as a fork | **No**; it is offered upstream instead |
| Further database fault experiments or a restart watchdog in this release | **No** |

**Stopping point (2026-11-05).** The investigation was meant to choose a database. It ended up qualifying, and then patching, the consensus library under it. Owning an unreviewed consensus patch, and carrying it through future upgrades, costs more than this release needs. So the work stops here:

1. The harness, results, patch and the explanations of excluded runs stay in this PR as evidence.
2. The two raft findings go upstream as focused reports with the proposed changes (drafts in [`upstream/`](upstream/)).
3. No further fault experiments, and no watchdog, for this release.
4. The release returns to single-node, with a recovery procedure that has been exercised.

rqlite remains the preferred HA candidate.

**If HA becomes a release requirement,** the next step is a strictly time-boxed check of whether a watchdog is feasible, before any fork is accepted. That is a project of its own, not a one-day escape. It must first show that stock rqlite exposes a trustworthy signal for "snapshot installation has stopped progressing". Readiness failing alone does not identify it, and restarting members whenever they cannot serve could disrupt an election or partition that would have recovered. It must then show that restarting the affected process restores service without restart loops. If that cannot be shown simply, the release scope gets reconsidered.

**What stock rqlite does not guarantee:** recovery when the leader is lost during a snapshot install has no bound. About 155 s was observed with the leader killed or cut inbound. That is an observation, not a guarantee, and a paused or half-alive leader stalled the cluster indefinitely. A follower far enough behind to need a snapshot is an ordinary operating condition, not a rare double fault, so how often this would happen is unknown.

Conditions already established for any clustered deployment: node mutual TLS, with fresh cluster credentials and membership on disaster restore; restore incarnations and the application fence; `?transaction` on every multi-statement request; linearizable reads for authorization and ownership. Still not covered: ClickHouse fencing, power loss, amd64 under faults, and the real Bun application's memory.

rqlite runs as a supervised process beside Bun and Go in the app container. That keeps the two-container deployment, and the budget run measured the three together.

**Upstream reports to file** (reproductions and expected behaviour, without claiming fault):

- hashicorp/raft (via rqlite): a follower in a restored cluster accepted `AppendEntries` and `InstallSnapshot` from a member that was not in its configuration (section 3).
- hashicorp/raft v1.8.0: `installSnapshot` reads the stream on the main loop with no deadline. When the leader is lost mid-transfer, the follower cannot vote, and a 3-member cluster stops writing for about 155 s (leader killed or cut inbound), or indefinitely (leader paused). The reproducer is `rq-snapstall` (section 5, `raft.go:1909`). Offer the idle-deadline change from the patch.
- hashicorp/raft v1.8.0: `installSnapshot` leaves a same-term candidate a candidate while recording the sender as leader, unlike `appendEntries`. If the install then fails, that member rejects every pre-vote "since we have a leader" until the old leader returns. Offer the one-line change and its test from the patch.
- rqlite docs: `?transaction` is what makes a batch stop at the first failed statement (section 1).
