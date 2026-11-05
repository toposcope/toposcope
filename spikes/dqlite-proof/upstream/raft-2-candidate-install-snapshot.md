<!-- Title: installSnapshot leaves a same-term candidate a candidate while recording the sender as leader; after a failed install it rejects every pre-vote -->

### Summary

`appendEntries` makes the receiver a follower when the request carries a newer term, **or** when the receiver is not a follower and the term is equal:

```go
if a.Term > r.getCurrentTerm() || (r.getState() != Follower && !r.candidateFromLeadershipTransfer.Load()) {
```

`installSnapshot` changes state only for a newer term (`req.Term > r.getCurrentTerm()`), but records the sender as leader either way (`r.setLeader(...)`). A candidate that receives `InstallSnapshot` at its own term therefore stays a candidate with a known leader.

With pre-vote enabled (the default), a candidate whose pre-votes fail keeps its term, so that same-term `InstallSnapshot` arrives easily. A member that was partitioned, and is then sent a snapshot by the leader it falls behind, is one example. If the install then fails, for example because the leader is lost part way through:
- the member remains a candidate and keeps recording the lost leader;
- `requestPreVote` and `requestVote` reject every other member "since we have a leader";
- nothing clears the leader: `setState` clears it only on a state transition, and the candidate restarts its elections without one.

If its vote is needed for a quorum, no member can be elected until the old leader returns.

### Version

`main` at a5b4692 (v1.8.0 plus CI and copyright changes). Go 1.27, linux/arm64.

### Reproduction

The test below is self-contained. Save it as `repro_candidate_install_test.go` in the repository root and run `go test -run TestRepro_CandidateKeepsLeaderAfterFailedInstall -v .`.

It starts one real Raft server F in a three-voter configuration:
- L is unreachable, and P refuses every vote, so F becomes a candidate and keeps its term.
- A raw connection playing L sends `InstallSnapshot` at F's current term, announcing 1 MiB, sends 4 KiB, then closes, so the install fails.
- Two seconds later (ten heartbeat timeouts), P asks F for a pre-vote with a newer term and a longer log.

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

// A candidate that is sent InstallSnapshot at its own term records the
// sender as leader but stays a candidate. If the install then fails (here
// the leader's connection closes part way), it keeps rejecting every
// pre-vote "since we have a leader", and nothing clears that leader while
// it stays a candidate.
func TestRepro_CandidateKeepsLeaderAfterFailedInstall(t *testing.T) {
	peer, err := NewTCPTransport("127.0.0.1:0", nil, 2, time.Second, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	go func() { // P refuses every vote F asks for, so F stays a candidate
		for rpc := range peer.Consumer() {
			switch req := rpc.Command.(type) {
			case *RequestPreVoteRequest:
				rpc.Respond(&RequestPreVoteResponse{Term: req.Term}, nil)
			case *RequestVoteRequest:
				rpc.Respond(&RequestVoteResponse{Term: req.Term}, nil)
			default:
				rpc.Respond(nil, nil)
			}
		}
	}()
	const leaderAddr = ServerAddress("127.0.0.1:1") // L is unreachable
	r, trans := newReproFollower(t, leaderAddr, peer.LocalAddr())

	deadline := time.Now().Add(10 * time.Second)
	for r.State() != Candidate {
		if time.Now().After(deadline) {
			t.Fatalf("F never became a candidate (state %v)", r.State())
		}
		time.Sleep(10 * time.Millisecond)
	}
	term := r.getCurrentTerm() // with pre-vote, a failing candidate keeps its term

	conn := startSnapshot(t, trans.LocalAddr(), leaderAddr, term, 1<<20, 4<<10)
	_ = conn.Close()            // L is lost part way through: the install fails
	time.Sleep(2 * time.Second) // ten heartbeat timeouts

	var resp RequestPreVoteResponse
	if err := peer.RequestPreVote("F", trans.LocalAddr(), &RequestPreVoteRequest{
		RPCHeader:    RPCHeader{ProtocolVersion: ProtocolVersionMax, ID: []byte("P"), Addr: []byte(peer.LocalAddr())},
		Term:         term + 1,
		LastLogIndex: 1000,
		LastLogTerm:  term,
	}, &resp); err != nil {
		t.Fatal(err)
	}
	if !resp.Granted {
		addr, id := r.LeaderWithID()
		t.Fatalf("pre-vote refused 2s after the failed install: F is %v and still records leader %s (%s)", r.State(), id, addr)
	}
}
```

**Observed on `main`** (10 of 10 runs):

```
[WARN]  raft: rejecting pre-vote request since we have a leader: from=127.0.0.1:36605 leader=127.0.0.1:1 leader-id=L
    repro_candidate_install_test.go:125: pre-vote refused 2s after the failed install: F is Candidate and still records leader L (127.0.0.1:1)
--- FAIL: TestRepro_CandidateKeepsLeaderAfterFailedInstall (2.35s)
```

**Expected:** `InstallSnapshot` from the leader of the current term makes a candidate a follower, as `AppendEntries` does. After a failed install, the follower's heartbeat timeout then clears the leader as usual, and it can grant votes.

### Impact observed in an application

With rqlite v10.6.6 (hashicorp/raft v1.8.0), the cluster had 3 members, a lagging follower was installing a snapshot, and the leader was killed. In 1 of 5 trials, the remaining two had not elected a leader after 300 s. The follower's log showed:

```
[ERROR] failed to copy snapshot: error="read tcp ...: i/o timeout"
[WARN]  Election timeout reached, restarting election        (repeated)
[WARN]  rejecting pre-vote request since we have a leader: from=<other member> leader=<lost leader> leader-id=<lost leader>
```

The other member, in turn, refused the follower: "rejecting pre-vote request since our last index is greater". That run also carried an idle deadline on the snapshot stream, which is why the copy failed with a timeout. The reproduction above needs no such change: closing the connection part way is enough.

### Proposed fix

Apply the `appendEntries` condition in `installSnapshot`:

```diff
-	// Increase the term if we see a newer one
-	if req.Term > r.getCurrentTerm() {
+	// Increase the term if we see a newer one, also transition to follower
+	// if we get an installSnapshot call from the leader of our term
+	if req.Term > r.getCurrentTerm() || (r.getState() != Follower && !r.candidateFromLeadershipTransfer.Load()) {
```

With only this change on `main`, the reproduction passes 10 of 10 runs. The rest of the suite shows the same failures with and without the change:
- `TestFileSS_BadPerm` cannot pass as root in a container.
- `TestRaft_HasExistingState`, `TestRaft_ProtocolVersion_Upgrade_1_2` and `TestRaft_ProtocolVersion_Upgrade_2_3` fail intermittently. Over 20 runs each, the counts were 5, 5 and 8 failures without the change, and 6, 6 and 8 with it. A focused unit test is also ready: it calls `installSnapshot` on a candidate at the request's term and checks that it becomes a follower; it fails without the change. We can open a PR with both.

### Related

#472 shows a 3-member cluster stuck with a candidate rejecting votes "since we have a leader". Its trigger was not identified, so it may or may not be this.
