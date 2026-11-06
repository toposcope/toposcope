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
