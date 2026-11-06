<!-- Title: Follower blocks in installSnapshot indefinitely when the leader stops sending mid-stream (reproduction for #700 / #703) -->

### Summary

While a follower is receiving a snapshot, `installSnapshot` copies the stream on the main loop (`raft.go`, `io.Copy(sink, countingRPCReader)`). On the follower side, nothing sets a read deadline on that stream: in `handleCommand`, `rpc.Reader` is an `io.LimitReader` over the connection. If the leader stops sending part way and the connection stays open, the copy blocks indefinitely. Until it returns, the follower answers no other RPC, so it cannot vote. That is the case @schmichael asked about in #700: "netio that doesn't respect the configured timeout, and therefore could block indefinitely in the absence of keepalives".

The connection stays open, with keepalives answered, when the leader's process is paused (SIGSTOP, a long GC or VM pause, a hung host process) or half-alive.

### Version

`main` at a5b4692 (v1.8.0 plus CI and copyright changes). Go 1.27, linux/arm64.

### Reproduction

The test below is self-contained. Save it as `repro_stalled_snapshot_test.go` in the repository root and run `go test -run TestRepro_StalledSnapshotStreamBlocksFollower -v .`.

It starts one real Raft server F over `NetworkTransport`, in a three-voter configuration. A raw connection plays the leader: it sends an `InstallSnapshot` announcing 1 MiB, sends 64 KiB, then sends nothing more and keeps the connection open. Another member then sends F a `RequestVote`.

```go
package raft

import (
	"bufio"
	"net"
	"testing"
	"time"

	"github.com/hashicorp/go-msgpack/v2/codec"
)

// newReproFollower starts one real Raft server, "F", over NetworkTransport,
// in a three-voter configuration whose other members are "L" and "P".
func newReproFollower(t *testing.T, leaderAddr, peerAddr ServerAddress) (*Raft, *NetworkTransport) {
	t.Helper()
	trans, err := NewTCPTransport("127.0.0.1:0", nil, 2, time.Second, nil)
	if err != nil {
		t.Fatal(err)
	}
	conf := DefaultConfig()
	conf.LocalID = "F"
	conf.HeartbeatTimeout = 200 * time.Millisecond
	conf.ElectionTimeout = 200 * time.Millisecond
	conf.LeaderLeaseTimeout = 100 * time.Millisecond
	conf.CommitTimeout = 10 * time.Millisecond
	store := NewInmemStore()
	snaps := NewInmemSnapshotStore()
	cfg := Configuration{Servers: []Server{
		{Suffrage: Voter, ID: "F", Address: trans.LocalAddr()},
		{Suffrage: Voter, ID: "L", Address: leaderAddr},
		{Suffrage: Voter, ID: "P", Address: peerAddr},
	}}
	if err := BootstrapCluster(conf, store, store, snaps, trans, cfg); err != nil {
		t.Fatal(err)
	}
	r, err := NewRaft(conf, &MockFSM{}, store, store, snaps, trans)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = r.Shutdown().Error(); _ = trans.Close() })
	return r, trans
}

// startSnapshot plays leader "L": it opens a connection to F and sends an
// InstallSnapshot RPC announcing size bytes, followed by only sent bytes.
func startSnapshot(t *testing.T, to ServerAddress, leaderAddr ServerAddress, term uint64, size, sent int64) net.Conn {
	t.Helper()
	conn, err := net.Dial("tcp", string(to))
	if err != nil {
		t.Fatal(err)
	}
	w := bufio.NewWriter(conn)
	enc := codec.NewEncoder(w, &codec.MsgpackHandle{})
	_ = w.WriteByte(rpcInstallSnapshot)
	err = enc.Encode(&InstallSnapshotRequest{
		RPCHeader:          RPCHeader{ProtocolVersion: ProtocolVersionMax, ID: []byte("L"), Addr: []byte(leaderAddr)},
		SnapshotVersion:    SnapshotVersionMax,
		Term:               term,
		LastLogIndex:       100,
		LastLogTerm:        term,
		Configuration:      EncodeConfiguration(Configuration{}),
		ConfigurationIndex: 1,
		Size:               size,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, _ = w.Write(make([]byte, sent))
	if err := w.Flush(); err != nil {
		t.Fatal(err)
	}
	return conn
}

// A leader that stops sending part way through a snapshot, but whose
// connection stays open (a paused process; its kernel still acknowledges),
// leaves the follower's main loop blocked in installSnapshot: the follower
// answers no other RPC, so it cannot vote.
func TestRepro_StalledSnapshotStreamBlocksFollower(t *testing.T) {
	peer, err := NewTCPTransport("127.0.0.1:0", nil, 2, time.Minute, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	const leaderAddr = ServerAddress("127.0.0.1:1")
	r, trans := newReproFollower(t, leaderAddr, peer.LocalAddr())

	conn := startSnapshot(t, trans.LocalAddr(), leaderAddr, r.getCurrentTerm()+1, 1<<20, 64<<10)
	defer conn.Close() // held open, never written to again
	time.Sleep(500 * time.Millisecond)

	answered := make(chan error, 1)
	go func() {
		var resp RequestVoteResponse
		answered <- peer.RequestVote("F", trans.LocalAddr(), &RequestVoteRequest{
			RPCHeader:    RPCHeader{ProtocolVersion: ProtocolVersionMax, ID: []byte("P"), Addr: []byte(peer.LocalAddr())},
			Term:         r.getCurrentTerm() + 1,
			LastLogIndex: 1000,
			LastLogTerm:  r.getCurrentTerm(),
		}, &resp)
	}()
	select {
	case err := <-answered:
		if err != nil {
			t.Fatalf("RequestVote failed: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatalf("follower answered no RequestVote for 30s while a stalled snapshot stream was open (state %v)", r.State())
	}
}
```

**Observed on `main`:**

```
    repro_stalled_snapshot_test.go:108: follower answered no RequestVote for 30s while a stalled snapshot stream was open (state Follower)
--- FAIL: TestRepro_StalledSnapshotStreamBlocksFollower (30.51s)
```

The vote request is only processed during the test's cleanup, when closing the transport fails the install.

**Expected:** a follower whose snapshot stream stops delivering abandons the install within a bounded time, and answers RPCs again.

### Impact observed in an application

We found this with rqlite v10.6.6, which uses hashicorp/raft v1.8.0 and `NetworkTransport` with a 10 s timeout. The cluster had 3 members, a lagging follower was installing a multi-MB snapshot, and the leader was lost; the partition was never healed. The two remaining members could not elect a leader, because the follower was stuck in `installSnapshot`:

| Leader lost by | Trials | Remaining two committed again after |
| --- | --- | --- |
| SIGSTOP | 4 | not within 300 s |
| dropping its inbound traffic | 5 | 154–158 s |
| SIGKILL of its container | 5 | 154–156 s |

We have not established what ended the second and third cases.

### Related

- **#703 fixes this reproduction.** On #703's branch (9fb9776) the test passes, answering after about 2 s with the test's 1 s transport timeout. That appears to be one timeout for the copy, plus another for the drain that `installSnapshot` defers (`io.Copy(io.Discard, rpc.Reader)`): after the first timeout, the next read sets a fresh deadline and waits again. Making the first read error sticky for the rest of the snapshot stream would remove the second wait. This test may be useful as a regression test for #703.
- #699 and #700 discussed a read deadline in `handleConn` and keepalives.
- #585 and #588 cover the leader side of a long snapshot transfer, during shutdown.
