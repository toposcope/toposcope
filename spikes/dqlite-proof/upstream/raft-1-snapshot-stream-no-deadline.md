**Title:** Follower blocks in installSnapshot with no read deadline when the leader is lost mid-transfer

**Version:** hashicorp/raft v1.8.0, via rqlite v10.6.6 (NetworkTransport over TLS), linux/arm64, Go 1.27.

**What happens**

`installSnapshot` copies the snapshot stream on the follower's main loop (`raft.go:1909`, `io.Copy(sink, countingRPCReader)`). The reader is `io.LimitReader` over the inbound connection (`net_transport.go`, `handleCommand`), and nothing sets a read deadline on it. If the leader stops sending part way, the copy blocks until the connection fails. While it is blocked, the follower cannot time out, vote or stand for election.

In a 3-member cluster, losing the leader during a transfer to a lagging follower leaves the other two without a quorum:
- the follower blocked in `installSnapshot` cannot vote;
- the remaining member stands for election alone.

**Reproduction.** Three members at rqlite defaults:
1. Partition follower F. Write until the leader L has compacted past F's last index, so F needs a snapshot (a several-MB database).
2. Shape L to F to 2 Mbit/s and heal F. Wait until F's goroutine dump shows `raft.(*Raft).installSnapshot`.
3. Take L out, without healing.

| How L is lost | Trials | Time until F and the other member commit again |
| --- | --- | --- |
| L's inbound traffic dropped | 5 | 154–158 s |
| L killed (container gone, no reset) | 5 | 154–156 s |
| L paused (SIGSTOP; its kernel still answers TCP) | 4 | none within 300 s |

At 10 s and 60 s, F still reported itself a follower of L, inside `installSnapshot`:

```
goroutine 50 [IO wait, 2 minutes]:
crypto/tls.(*Conn).Read ...
github.com/hashicorp/raft.(*countingReader).Read     progress.go:106
io.Copy
github.com/hashicorp/raft.(*Raft).installSnapshot     raft.go:1909
github.com/hashicorp/raft.(*Raft).processRPC          raft.go:1422
github.com/hashicorp/raft.(*Raft).runFollower         raft.go:172
```

We have not confirmed what ends the ~155 s cases. TCP keepalive on the follower's end fits all three modes (Go's 15 s idle plus 9 probes at 15 s), but it was not tested. The harness is `cmd/runner/snapstall.go` in our proof.

**Expected:** a follower whose snapshot stream stops delivering abandons the install within a bounded time, and returns to its main loop, where it can vote.

**Proposed change**
- A per-read idle deadline on the incoming snapshot stream: `NetworkTransportConfig.SnapshotIdleTimeout`, defaulting to 5 s; a negative value disables it.
- A stream that keeps delivering is never cut, however long the whole transfer takes.
- On timeout, the existing error path cancels the sink and responds.
- The failure is sticky, so the deferred drain `io.Copy(io.Discard, rpc.Reader)` returns at once.
- The connection is closed after the response, because unread snapshot bytes remain on it.
- A complete stream clears the deadline, and the connection is reused.

With this change and the one in the companion report, the same reproduction recovered in 5.8–9.6 s in 30 of 30 trials (10 per mode). There are tests for a stalled stream (abandoned after the idle time, connection closed) and a complete one (connection reused afterwards). The full suite shows the same failures as unpatched v1.8.0.

Open questions for maintainers:
- whether the default should be on;
- whether 5 s is right;
- whether the bound belongs in the transport or in `installSnapshot`.
