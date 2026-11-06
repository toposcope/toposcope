package main

// snapStall is the targeted reproducer for the snapshot-install stall
// (RESULTS-rqlite.md section 5), at the settings under test (rqlite's
// defaults unless RQ_ARGS says otherwise). Each trial:
//
//  1. cuts a follower F off and writes until the leader L has compacted its
//     log past F (F can then only catch up from a snapshot);
//  2. slows L's traffic to F (tc) and lets F back, so the snapshot transfer
//     is long enough to cut into, and waits until F's goroutines show Raft
//     installing it;
//  3. takes L out, by mode: asym-in cuts its inbound traffic (it can still
//     send); pause SIGSTOPs it (its kernel still acknowledges); kill
//     SIGKILLs it (the control: its kernel resets the connections);
//  4. without healing, measures how long F and the other follower O, which
//     can still talk to each other, take to commit a write again.
//
// The partition stays in place for up to SNAPSTALL_WAIT_S (default 300 s).

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"
)

type rqRaft struct {
	State            string
	LastLog, Applied uint64
	LastSnap         uint64
	Leader           string
}

func rqStatus(n Node) (rqRaft, error) {
	c := *httpc
	c.Timeout = 2 * time.Second
	resp, err := c.Get(fmt.Sprintf("http://%s:4001/status", n.IP))
	if err != nil {
		return rqRaft{}, err
	}
	defer resp.Body.Close()
	var m struct {
		Store struct {
			Leader struct{ Addr string } `json:"leader"`
			Raft   map[string]any        `json:"raft"`
		} `json:"store"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&m); err != nil {
		return rqRaft{}, err
	}
	u := func(k string) uint64 {
		switch v := m.Store.Raft[k].(type) {
		case string:
			var x uint64
			fmt.Sscan(v, &x)
			return x
		case float64:
			return uint64(v)
		}
		return 0
	}
	st, _ := m.Store.Raft["state"].(string)
	return rqRaft{State: st, LastLog: u("last_log_index"), Applied: u("applied_index"), LastSnap: u("last_snapshot_index"), Leader: m.Store.Leader.Addr}, nil
}

// installing reports whether n's Raft is inside installSnapshot.
func installing(n Node) bool {
	c := *httpc
	c.Timeout = 3 * time.Second
	resp, err := c.Get(fmt.Sprintf("http://%s:4001/debug/pprof/goroutine?debug=2", n.IP))
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return strings.Contains(string(b), "raft.(*Raft).installSnapshot")
}

func shaping(L, F Node, rate string) error {
	return sh(L, fmt.Sprintf("tc qdisc add dev eth0 root handle 1: prio && "+
		"tc qdisc add dev eth0 parent 1:3 handle 30: tbf rate %s burst 32kbit latency 2s && "+
		"tc filter add dev eth0 protocol ip parent 1:0 prio 3 u32 match ip dst %s/32 flowid 1:3", rate, F.IP))
}

func unshape(n Node) { _ = sh(n, "tc qdisc del dev eth0 root 2>/dev/null; true") }

func snapStall() {
	trials := envInt("SNAPSTALL_TRIALS", 3)
	modes := strings.Split(env("SNAPSTALL_MODES", "asym-in,pause,kill"), ",")
	wait := time.Duration(envInt("SNAPSTALL_WAIT_S", 300)) * time.Second
	rate := env("SNAPSTALL_RATE", "2mbit")
	L, err := leader(cluster)
	if err != nil {
		die("%v", err)
	}
	// A database of a realistic size, so the snapshot is several MB.
	must(L, "POST", "/seed?sessions=50000&monitors=10000&tokens=5000", 10*time.Minute)

	var rows []map[string]any
	var checks []Check
	for _, mode := range modes {
		for i := 0; i < trials; i++ {
			row := snapStallTrial(mode, i, wait, rate)
			rows = append(rows, row)
			b, _ := json.Marshal(row)
			logf("snapstall %s trial %d: %s", mode, i, b)
		}
	}
	record("snapstall", rows)
	for _, mode := range modes {
		checks = append(checks, snapStallCheck(mode, rows, wait))
	}
	record("checks_snapstall", checks)
}

func snapStallCheck(mode string, rows []map[string]any, wait time.Duration) Check {
	stalled, notReached, recovered := 0, 0, 0
	var worst int64
	for _, r := range rows {
		if r["mode"] != mode {
			continue
		}
		if r["installing_at_cut"] != true {
			notReached++
			continue
		}
		ms, _ := r["majority_write_after_cut_ms"].(int64)
		if ms < 0 || ms > 10_000 {
			stalled++
		} else {
			recovered++
		}
		if ms < 0 {
			ms = wait.Milliseconds()
		}
		worst = max(worst, ms)
	}
	return Check{"snapshot install, leader lost by " + mode + ": the other two commit within 10 s, without heal", stalled == 0 && recovered > 0,
		fmt.Sprintf("%d trials during a confirmed snapshot install: %d recovered within 10 s, %d did not (worst %d ms, cap %s); %d never reached an install",
			recovered+stalled, recovered, stalled, worst, wait, notReached)}
}

func snapStallTrial(mode string, i int, wait time.Duration, rate string) map[string]any {
	L, err := leader(cluster)
	if err != nil {
		die("%v", err)
	}
	peers := others(L, cluster)
	F, O := peers[0], peers[1]
	out := map[string]any{"mode": mode, "trial": i, "leader": L.Name, "behind": F.Name, "other": O.Name}

	// 1. F falls behind past the leader's retained log.
	if err := partition(F, others(F, cluster)); err != nil {
		die("partition: %v", err)
	}
	fs, _ := rqStatus(F)
	// The leader keeps 10,240 entries behind its last snapshot (rqlite's
	// default: 1.25 x the 8,192 threshold), so its log no longer reaches
	// F once the snapshot index is past F's last entry plus that.
	need := fs.LastLog + 10240 + 500
	for k := 0; ; k++ {
		ls, err := rqStatus(L)
		if err == nil && ls.LastSnap > need {
			out["writes_while_behind"] = ls.LastLog - fs.LastLog
			out["leader_snapshot_index"], out["follower_last_index"] = ls.LastSnap, fs.LastLog
			break
		}
		if k > 60 {
			die("leader never compacted past the follower: %+v (follower at %d)", ls, fs.LastLog)
		}
		must(L, "POST", "/bench?op=session_create&n=5000&conc=32", 5*time.Minute)
		time.Sleep(time.Second)
	}

	// 2. Slow L -> F, let F back, wait for the install to start.
	if err := shaping(L, F, rate); err != nil {
		die("tc: %v", err)
	}
	if err := heal(F); err != nil {
		die("heal: %v", err)
	}
	t0 := time.Now()
	started := false
	for time.Since(t0) < 60*time.Second {
		if installing(F) {
			started = true
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	out["installing_at_cut"] = started
	out["install_started_after_ms"] = time.Since(t0).Milliseconds()
	if !started {
		unshape(L)
		waitHealthy(cluster, 3*time.Minute)
		return out
	}
	time.Sleep(time.Second)

	// 3. L can send, receives nothing.
	w := startWorkload([]Node{O, F}, fmt.Sprintf("ss-%s-%d", mode, i))
	tc := time.Now()
	switch mode {
	case "asym-in":
		err = oneWay(L, peers, "in")
	case "pause":
		err = pause(L)
	case "kill":
		err = dkill(L, "KILL")
	default:
		die("unknown snapstall mode %q", mode)
	}
	if err != nil {
		die("%s: %v", mode, err)
	}

	// 4. Without heal: when does the majority commit again?
	first := int64(-1)
	var at10, at60 map[string]any
	snap := func() map[string]any {
		m := map[string]any{"follower_installing": installing(F)}
		for _, n := range peers {
			if s, err := rqStatus(n); err == nil {
				m[n.Name] = fmt.Sprintf("%s leader=%s last=%d", s.State, s.Leader, s.LastLog)
			}
		}
		return m
	}
	for time.Since(tc) < wait {
		for _, n := range []Node{O, F} {
			if _, err := ok(n, "POST", fmt.Sprintf("/hw?id=ss-%d-%s-%d", i, n.Name, time.Now().UnixNano()), time.Second); err == nil && first < 0 {
				first = time.Since(tc).Milliseconds()
			}
		}
		if at10 == nil && time.Since(tc) > 10*time.Second {
			at10 = snap()
			if first < 0 {
				diagnose(fmt.Sprintf("%s-snapstall-%s-%d", label, mode, i))
			}
		}
		if at60 == nil && time.Since(tc) > 60*time.Second {
			at60 = snap()
		}
		if first >= 0 && time.Since(tc) > 12*time.Second {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	out["majority_write_after_cut_ms"] = first
	out["state_at_10s"], out["state_at_60s"] = at10, at60
	w.Stop()
	out["write_gap_ms"] = w.gap(tc, time.Now()).Milliseconds()

	// Heal, then check what was acknowledged is there.
	switch mode {
	case "asym-in":
		_ = heal(L)
	case "pause":
		_ = resume(L)
	case "kill":
		_ = dstart(L)
		time.Sleep(2 * time.Second)
	}
	unshape(L)
	out["healthy_after_heal_ms"] = waitHealthy(cluster, 3*time.Minute).Milliseconds()
	l2, _ := leader(cluster)
	missing := 0
	w.mu.Lock()
	for _, a := range w.created {
		if count(l2, fmt.Sprintf("SELECT count(*) AS c FROM sessions WHERE id = '%s'", a.ID)) != 1 {
			missing++
		}
	}
	out["acked_sessions"], out["acked_missing"] = len(w.created), missing
	w.mu.Unlock()
	time.Sleep(3 * time.Second)
	return out
}
