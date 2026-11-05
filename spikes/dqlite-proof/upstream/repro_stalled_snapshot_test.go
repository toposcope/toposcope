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
