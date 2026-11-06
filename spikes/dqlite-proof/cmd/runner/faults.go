package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"
)

func faults() {
	logf("faults: workers on, session writers on")
	setWorkers(cluster, true)
	w := startWorkload(cluster, "w")
	time.Sleep(5 * time.Second)

	var events []map[string]any
	add := func(e map[string]any) {
		events = append(events, e)
		b, _ := json.Marshal(e)
		logf("  %s", b)
	}

	// Leader kill.
	{
		L, err := leader(cluster)
		if err != nil {
			die("%v", err)
		}
		t0 := time.Now()
		_ = dkill(L, "KILL")
		newLeader := waitNewLeader(others(L, cluster), L, 60*time.Second)
		time.Sleep(5 * time.Second)
		gap := w.gap(t0, time.Now())
		_ = dstart(L)
		rejoin := waitHealthy(cluster, 2*time.Minute)
		add(map[string]any{"fault": "leader kill (SIGKILL)", "node": L.Name, "new_leader_ms": newLeader.Milliseconds(), "write_gap_ms": gap.Milliseconds(), "rejoin_ms": rejoin.Milliseconds()})
	}

	// 2-1 partitions isolating the leader: the revocation race.
	var trials []RevTrial
	for _, mode := range strings.Split(revModes, ",") {
		for i := 0; i < revTrials; i++ {
			trials = append(trials, revocationTrial(i, mode, w)...)
			time.Sleep(2 * time.Second)
		}
	}
	record("revocation_trials", trials)

	// 2-1 partition isolating a follower.
	fp := followerPartition(w)
	record("follower_partition", fp)
	add(fp)

	// Paused lease owner.
	var pauses []map[string]any
	for i := 0; i < pauseTrials; i++ {
		p := pauseTrial(w)
		pauses = append(pauses, p)
		add(p)
		time.Sleep(2 * time.Second)
	}
	record("pause_trials", pauses)

	// Restarts: a follower, the leader, then every member crashed at once.
	{
		L, _ := leader(cluster)
		F := others(L, cluster)[0]
		for _, n := range []Node{F, L} {
			role := "follower"
			if n == L {
				role = "leader"
			}
			t0 := time.Now()
			_ = drestart(n)
			h := waitHealthy(cluster, 2*time.Minute)
			add(map[string]any{"fault": "restart (SIGTERM, handover) " + role, "node": n.Name, "healthy_ms": (time.Since(t0)).Milliseconds(), "write_gap_ms": w.gap(t0, time.Now()).Milliseconds(), "wait_ms": h.Milliseconds()})
			time.Sleep(3 * time.Second)
		}
		t0 := time.Now()
		for _, n := range cluster {
			_ = dkill(n, "KILL")
		}
		time.Sleep(2 * time.Second)
		for _, n := range cluster {
			_ = dstart(n)
		}
		h := waitHealthy(cluster, 3*time.Minute)
		add(map[string]any{"fault": "all three SIGKILLed at once, then started", "healthy_after_start_ms": h.Milliseconds(), "write_gap_ms": w.gap(t0, time.Now()).Milliseconds()})
		time.Sleep(5 * time.Second)
	}

	record("fault_events", events)
	logf("faults: stopping writers and workers")
	w.Stop()
	setWorkers(cluster, false)
	time.Sleep(3 * time.Second)
	w.mu.Lock()
	record("workload", map[string]any{"sessions_acked": len(w.created), "revokes_acked": len(w.revoked), "failed_attempts": w.failures})
	w.mu.Unlock()
	verify(w)
}

func waitNewLeader(set []Node, old Node, timeout time.Duration) time.Duration {
	t := time.Now()
	for time.Since(t) < timeout {
		if n, err := leader(set); err == nil && n.Name != old.Name {
			return time.Since(t)
		}
		time.Sleep(20 * time.Millisecond)
	}
	die("no new leader among %v after %s", names(set), timeout)
	return 0
}

type Obs struct {
	Send, Recv time.Time
	OK, Valid  bool
}

type RevTrial struct {
	Mode                  string `json:"mode"`
	Trial                 int    `json:"trial"`
	Kind                  string `json:"kind"`
	OldLeader             string `json:"old_leader"`
	RevokeSentMs          int64  `json:"revoke_sent_ms"`
	RevokeAckMs           int64  `json:"revoke_acked_ms"`
	OldLeaderLastValidMs  int64  `json:"old_leader_last_valid_ms"`
	OldLeaderLastAnswerMs int64  `json:"old_leader_last_answer_ms"`
	OldLeaderFirstFailMs  int64  `json:"old_leader_first_fail_ms"`
	StaleWindowMs         int64  `json:"stale_window_ms"`
	StaleAfterAckMs       int64  `json:"stale_after_ack_ms"`
	ProvenStaleReads      int    `json:"proven_stale_reads"`
	ReadsOnOldLeader      int    `json:"reads_on_old_leader"`
	MajorityStaleReads    int    `json:"majority_stale_reads"`
	ValidAfterHeal        bool   `json:"valid_after_heal"`
	WriteGapMs            int64  `json:"write_gap_ms"`
	CommitFailed          bool   `json:"revocation_never_committed"`
	HealedMs              int64  `json:"healthy_after_heal_ms_if_failed,omitempty"`
	RecoveredMs           int64  `json:"healthy_after_heal_ms"`
}

func poller(n Node, path string, parse func(json.RawMessage) bool, stop <-chan struct{}, out *[]Obs, mu *sync.Mutex, wg *sync.WaitGroup) {
	defer wg.Done()
	for {
		select {
		case <-stop:
			return
		default:
		}
		s := time.Now()
		r, code, err := call(n, "GET", path, 300*time.Millisecond)
		o := Obs{Send: s, Recv: time.Now(), OK: err == nil && code == 200}
		if o.OK {
			o.Valid = parse(r.V)
		}
		mu.Lock()
		*out = append(*out, o)
		mu.Unlock()
		time.Sleep(5 * time.Millisecond)
	}
}

func parseBool(v json.RawMessage) bool { var b bool; _ = json.Unmarshal(v, &b); return b }
func parseToken(v json.RawMessage) bool {
	var t struct{ Valid bool }
	_ = json.Unmarshal(v, &t)
	return t.Valid
}

// retryUntil sends a write to the given members in turn until one commits.
func mustRetry(set []Node, method, path string) {
	t := time.Now()
	if _, _, err := retryUntil(set, method, path, 60*time.Second); err != nil {
		die("%v", err)
	}
	if d := time.Since(t); d > time.Second {
		logf("  note: setup write %s took %s", path, d.Round(time.Millisecond))
	}
}

func retryUntil(set []Node, method, path string, deadline time.Duration) (sent, acked time.Time, err error) {
	t := time.Now()
	for i := 0; time.Since(t) < deadline; i++ {
		n := set[i%len(set)]
		s := time.Now()
		if _, e := ok(n, method, path, time.Second); e == nil {
			return s, time.Now(), nil
		}
		time.Sleep(20 * time.Millisecond)
	}
	return time.Time{}, time.Time{}, fmt.Errorf("%s %s never committed in %s", method, path, deadline)
}

// revocationTrial isolates the leader, revokes a session and a token on the
// majority, and keeps asking the old leader whether they are still valid.
func revocationTrial(i int, mode string, w *Workload) []RevTrial {
	L, err := leader(cluster)
	if err != nil {
		die("%v", err)
	}
	peers := others(L, cluster)
	sid := fmt.Sprintf("rev-s-%d-%d", i, time.Now().UnixNano())
	tid := fmt.Sprintf("rev-t-%d-%d", i, time.Now().UnixNano())
	mustRetry(cluster, "POST", "/session?id="+sid)
	mustRetry(cluster, "POST", "/token?id="+tid)

	type kind struct {
		name, check, revoke string
		parse               func(json.RawMessage) bool
		obs                 []Obs
		sent, acked         time.Time
		failed              bool
	}
	kinds := []*kind{
		{name: "session", check: "/check?id=" + sid, revoke: "/revoke?id=" + sid, parse: parseBool},
		{name: "token", check: "/token/check?id=" + tid, revoke: "/token/revoke?id=" + tid, parse: parseToken},
	}
	var mu sync.Mutex
	var wg sync.WaitGroup
	stop := make(chan struct{})
	for _, k := range kinds {
		for p := 0; p < 3; p++ {
			wg.Add(1)
			go poller(L, k.check, k.parse, stop, &k.obs, &mu, &wg)
		}
	}
	time.Sleep(300 * time.Millisecond)
	t0 := time.Now()
	var err2 error
	switch mode {
	case "partition":
		err2 = partition(L, peers)
	case "partition+cpu":
		// The old leader gets 5% of a CPU: its ticks, and so its step-down, run late.
		if err2 = throttle(L, 50_000_000); err2 == nil {
			err2 = partition(L, peers)
		}
	case "pause+partition":
		// Stopped and cut off; it is let go, still cut off, once the
		// majority has acknowledged the revocation.
		if err2 = pause(L); err2 == nil {
			err2 = partition(L, peers)
		}
	case "asym-in":
		err2 = oneWay(L, peers, "in")
	case "asym-out":
		err2 = oneWay(L, peers, "out")
	default:
		die("unknown revocation mode %q", mode)
	}
	if err2 != nil {
		die("%s: %v", mode, err2)
	}
	var rwg sync.WaitGroup
	for _, k := range kinds {
		rwg.Add(1)
		go func(k *kind) {
			defer rwg.Done()
			s, a, err := retryUntil(peers, "POST", k.revoke, 120*time.Second)
			if err != nil {
				// An unsuccessful recovery: recorded, not fatal.
				logf("  RECOVERY FAILED (%s trial %d): %v", mode, i, err)
				k.failed = true
				return
			}
			k.sent, k.acked = s, a
		}(k)
	}
	rwg.Wait()
	anyFailed := false
	for _, k := range kinds {
		anyFailed = anyFailed || k.failed
	}
	if anyFailed {
		diagnose(fmt.Sprintf("%s-%s-%d", label, mode, i))
	}
	if mode == "pause+partition" {
		time.Sleep(100 * time.Millisecond)
		_ = resume(L)
	}
	// The majority must answer revoked from the moment of the ack.
	majorityStale := map[string]int{}
	for _, k := range kinds {
		for _, p := range peers {
			if r, err := ok(p, "GET", k.check, time.Second); err == nil && k.parse(r.V) {
				majorityStale[k.name]++
			}
		}
	}
	time.Sleep(time.Duration(2*electionMs)*time.Millisecond + 2*time.Second)
	close(stop)
	wg.Wait()
	if err := heal(L); err != nil {
		die("heal: %v", err)
	}
	if mode == "partition+cpu" {
		// NanoCpus 0 means "unchanged" to the update API: give back the whole host.
		if err := throttle(L, int64(runtime.NumCPU())*1_000_000_000); err != nil {
			die("unthrottle: %v", err)
		}
	}
	recovered := waitHealthy(cluster, 2*time.Minute)
	gap := w.gap(t0, time.Now())

	var out []RevTrial
	for _, k := range kinds {
		t := RevTrial{Mode: mode, Trial: i, Kind: k.name, OldLeader: L.Name,
			RevokeSentMs: k.sent.Sub(t0).Milliseconds(), RevokeAckMs: k.acked.Sub(t0).Milliseconds(),
			OldLeaderLastValidMs: -1, OldLeaderLastAnswerMs: -1, OldLeaderFirstFailMs: -1,
			MajorityStaleReads: majorityStale[k.name], WriteGapMs: gap.Milliseconds(), RecoveredMs: recovered.Milliseconds(), CommitFailed: k.failed}
		if k.failed {
			// Never acknowledged: valid answers were correct, and the
			// revocation was not there to see after heal either.
			k.acked = time.Now().Add(time.Hour)
			t.HealedMs = recovered.Milliseconds()
		}
		var lastValid time.Time
		for _, o := range k.obs {
			if o.Send.Before(t0) {
				continue
			}
			t.ReadsOnOldLeader++
			if o.OK {
				t.OldLeaderLastAnswerMs = o.Recv.Sub(t0).Milliseconds()
				if o.Valid {
					t.OldLeaderLastValidMs = o.Recv.Sub(t0).Milliseconds()
					lastValid = o.Recv
					if o.Send.After(k.acked) {
						t.ProvenStaleReads++
						if d := o.Recv.Sub(k.acked).Milliseconds(); d > t.StaleAfterAckMs {
							t.StaleAfterAckMs = d
						}
					}
				}
			} else if t.OldLeaderFirstFailMs < 0 {
				t.OldLeaderFirstFailMs = o.Recv.Sub(t0).Milliseconds()
			}
		}
		// Conservative: the revocation may have committed as soon as it was
		// sent, and the stale read may have been served as late as received.
		if k.failed {
			t.RevokeSentMs, t.RevokeAckMs = -1, -1
		} else if !lastValid.IsZero() && lastValid.After(k.sent) {
			t.StaleWindowMs = lastValid.Sub(k.sent).Milliseconds()
		}
		if k.failed {
			mustRetry(cluster, "POST", k.revoke)
		}
		for _, n := range cluster {
			if r, err := ok(n, "GET", k.check, 2*time.Second); err != nil || k.parse(r.V) {
				t.ValidAfterHeal = true
			}
		}
		b, _ := json.Marshal(t)
		logf("  revocation trial %s", b)
		out = append(out, t)
	}
	return out
}

// followerPartition isolates a follower: it must commit nothing and must
// not answer a revoked session as valid.
func followerPartition(w *Workload) map[string]any {
	L, _ := leader(cluster)
	F := others(L, cluster)[0]
	sid := fmt.Sprintf("fp-%d", time.Now().UnixNano())
	mustRetry(cluster, "POST", "/session?id="+sid)
	if r := must(F, "GET", "/check?id="+sid, 2*time.Second); !parseBool(r.V) {
		die("follower does not see the session before the partition")
	}
	t0 := time.Now()
	if err := partition(F, others(F, cluster)); err != nil {
		die("partition: %v", err)
	}
	// How long the majority cannot commit: an interactive transaction the
	// isolated member had open on the leader holds its write lock until the
	// leader's side of that connection is declared dead.
	_, acked, err := retryUntil([]Node{L}, "POST", "/revoke?id="+sid, 120*time.Second)
	if err != nil {
		die("%v", err)
	}
	var obs []Obs
	var mu sync.Mutex
	var wg sync.WaitGroup
	stop := make(chan struct{})
	wg.Add(1)
	go poller(F, "/check?id="+sid, parseBool, stop, &obs, &mu, &wg)
	writeOK := 0
	for k := 0; k < 5; k++ {
		if _, err := ok(F, "POST", fmt.Sprintf("/session?id=fp-w-%d-%d", k, time.Now().UnixNano()), time.Second); err == nil {
			writeOK++
		}
	}
	time.Sleep(time.Duration(2*electionMs)*time.Millisecond + 2*time.Second)
	close(stop)
	wg.Wait()
	valid, answered := 0, 0
	for _, o := range obs {
		if o.OK {
			answered++
			if o.Valid {
				valid++
			}
		}
	}
	gap := w.gap(t0, time.Now())
	_ = heal(F)
	h := waitHealthy(cluster, 2*time.Minute)
	return map[string]any{"fault": "2-1 partition isolating a follower", "node": F.Name, "majority_write_stall_ms": acked.Sub(t0).Milliseconds(),
		"reads_on_lone_follower": len(obs), "answered": answered, "answered_valid_after_revoke": valid,
		"writes_committed_on_lone_follower": writeOK, "write_gap_ms": gap.Milliseconds(), "rejoin_ms": h.Milliseconds()}
}

func leaseRow(set []Node, name string) (string, int64, bool) {
	for _, n := range set {
		r, err := ok(n, "GET", "/q?sql="+urlq(fmt.Sprintf("SELECT owner, gen FROM leases WHERE name = '%s'", name)), time.Second)
		if err != nil {
			continue
		}
		var rows []map[string]any
		_ = json.Unmarshal(r.V, &rows)
		if len(rows) == 1 {
			owner, _ := rows[0]["owner"].(string)
			return owner, num(rows[0]["gen"]), true
		}
	}
	return "", 0, false
}

func nodeStat(n Node, key string) int64 {
	s, err := status(n)
	if err != nil {
		return -1
	}
	switch v := s.Stats[key].(type) {
	case float64:
		return int64(v)
	case map[string]any:
		return num(v["stale"])
	}
	return -1
}

// pauseTrial SIGSTOPs the scheduler owner and waits for another member to
// take the lease over. It sends SIGCONT after the takeover, or after 20 s
// without one, and then counts the writes its old generation tried and had
// refused. While the owner is stopped it probes a write through each other
// member, to see what is holding things up when no takeover comes.
func pauseTrial(w *Workload) map[string]any {
	owner, g0, found := leaseRow(cluster, "scheduler")
	if !found || owner == "" {
		die("no scheduler owner")
	}
	var O Node
	for _, n := range cluster {
		if n.Name == owner {
			O = n
		}
	}
	L, _ := leader(cluster)
	before := nodeStat(O, "stale_refused")
	lostBefore := nodeStat(O, "leases_lost")
	t0 := time.Now()
	if err := pause(O); err != nil {
		die("pause: %v", err)
	}
	var takeover time.Duration
	var newOwner string
	var g1 int64
	probes := map[string]string{}
	probed := false
	resumed := time.Time{}
	for time.Since(t0) < 80*time.Second {
		if o, g, f := leaseRow(others(O, cluster), "scheduler"); f && g > g0 && o != O.Name {
			takeover, newOwner, g1 = time.Since(t0), o, g
			break
		}
		if !probed && time.Since(t0) > 8*time.Second {
			probed = true
			for _, n := range others(O, cluster) {
				_, err := ok(n, "POST", fmt.Sprintf("/hw?id=probe-%s-%d", n.Name, time.Now().UnixNano()), 2*time.Second)
				probes[n.Name] = fmt.Sprint(err)
			}
		}
		if resumed.IsZero() && time.Since(t0) > 20*time.Second {
			resumed = time.Now()
			_ = resume(O)
		}
		time.Sleep(50 * time.Millisecond)
	}
	if resumed.IsZero() {
		time.Sleep(time.Second)
		resumed = time.Now()
		if err := resume(O); err != nil {
			die("resume: %v", err)
		}
	}
	time.Sleep(5 * time.Second)
	after := nodeStat(O, "stale_refused")
	lostAfter := nodeStat(O, "leases_lost")
	gap := w.gap(t0, time.Now())
	h := waitHealthy(cluster, 2*time.Minute)
	out := map[string]any{"fault": "SIGSTOP scheduler owner, SIGCONT after takeover (or after 20 s)", "node": O.Name, "was_leader": O == L,
		"old_gen": g0, "new_gen": g1, "new_owner": newOwner, "takeover_ms": takeover.Milliseconds(),
		"took_over_while_paused":            takeover > 0 && t0.Add(takeover).Before(resumed),
		"stale_writes_refused_after_resume": after - before, "leases_given_up_after_resume": lostAfter - lostBefore,
		"write_gap_ms": gap.Milliseconds(), "healthy_ms": h.Milliseconds()}
	if takeover == 0 {
		out["takeover_ms"] = int64(-1)
	}
	if len(probes) > 0 {
		out["writes_probed_at_8s"] = probes
	}
	return out
}

// diagnose saves each member's goroutines (rqlited's pprof; nothing for
// dqlite) and its status, for a recovery that did not happen.
func diagnose(tag string) {
	_ = os.MkdirAll("/out/diag", 0o755)
	for _, n := range cluster {
		c := *httpc
		c.Timeout = 10 * time.Second
		if resp, err := c.Get(fmt.Sprintf("http://%s:4001/debug/pprof/goroutine?debug=2", n.IP)); err == nil {
			b, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			_ = os.WriteFile(fmt.Sprintf("/out/diag/%s-%s-goroutines.txt", tag, n.Name), b, 0o644)
		}
		if resp, err := c.Get(fmt.Sprintf("http://%s:4001/status", n.IP)); err == nil {
			b, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			_ = os.WriteFile(fmt.Sprintf("/out/diag/%s-%s-status.json", tag, n.Name), b, 0o644)
		}
		out, _, _ := dexec(n, "sh", "-c", "iptables -S; ps -o pid,stat,rss,comm -e 2>/dev/null || ps aux")
		_ = os.WriteFile(fmt.Sprintf("/out/diag/%s-%s-host.txt", tag, n.Name), []byte(out), 0o644)
	}
	logf("  diagnostics saved under out/diag/%s-*", tag)
}
