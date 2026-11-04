package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"
)

// guardTest runs the member's deterministic check of the transaction guard:
// a COMMIT made to fail by a deferred foreign key, and a deadline that passes
// before COMMIT, each with the guard off and on.
func guardTest() {
	L, err := leader(cluster)
	if err != nil {
		die("%v", err)
	}
	var rows []map[string]any
	var checks []Check
	for _, c := range []string{"commit", "cancel"} {
		for _, g := range []string{"0", "1"} {
			r := must(L, "POST", "/selftest/guard?case="+c+"&guard="+g, 30*time.Second)
			var m map[string]any
			_ = json.Unmarshal(r.V, &m)
			rows = append(rows, m)
			b, _ := json.Marshal(m)
			logf("guard test %s guard=%s: %s", c, g, b)
			safe := m["next_write_visible_elsewhere"] == true && m["other_writer_error"] == "<nil>" && m["failed_tx_row_visible"] == false
			if g == "1" {
				checks = append(checks, Check{"guard: after a failed " + c + ", the next write commits and nothing is held (" + c + ")", safe,
					fmt.Sprintf("tx error %q; next write visible elsewhere %v; another writer: %v", m["tx_error"], m["next_write_visible_elsewhere"], m["other_writer_error"])})
			} else if c == "commit" {
				checks = append(checks, Check{"guard off reproduces the poisoned connection", !safe && m["next_write_visible_after_pool_closed"] == false,
					fmt.Sprintf("next write acknowledged (error %v) but visible elsewhere %v and after the pool closed %v; another writer: %v", m["next_write_error"], m["next_write_visible_elsewhere"], m["next_write_visible_after_pool_closed"], m["other_writer_error"])})
			}
		}
	}
	record("guard_test", rows)
	record("checks_guard", checks)
}

// pauses runs only the paused-owner trials, many of them, with the workload
// on, then the correctness checks.
func pauses() {
	setWorkers(cluster, true)
	w := startWorkload(cluster, "w")
	time.Sleep(5 * time.Second)
	var out []map[string]any
	for i := 0; i < pauseTrials; i++ {
		p := pauseTrial(w)
		out = append(out, p)
		b, _ := json.Marshal(p)
		logf("  pause %d: %s", i, b)
		time.Sleep(2 * time.Second)
	}
	record("pause_trials", out)
	w.Stop()
	setWorkers(cluster, false)
	time.Sleep(3 * time.Second)
	verify(w)
}

// memoryBudget holds the members to the app container's limits (512 MB,
// one CPU, compose.yml) and runs Toposcope-sized work through repeated
// snapshot and cleanup cycles: monitor runs of five rows from 16 callers,
// with a cleanup job that deletes in chunks.
func memoryBudget() {
	const limitBytes = 512 << 20
	for _, n := range cluster {
		if err := limit(n, limitBytes, 1_000_000_000); err != nil {
			die("%v", err)
		}
	}
	L, err := leader(cluster)
	if err != nil {
		die("%v", err)
	}
	var rows []MemRow
	memSnap("start", &rows)
	t := time.Now()
	// The limit can cost the cluster its leader for a moment: wait for one.
	waitHealthy(cluster, 2*time.Minute)
	if L, err = leader(cluster); err != nil {
		die("%v", err)
	}
	must(L, "POST", "/seed?sessions=50000&monitors=10000&tokens=5000", 10*time.Minute)
	record("budget_seed_ms", time.Since(t).Milliseconds())
	memSnap("seeded", &rows)
	rounds := envInt("BUDGET_ROUNDS", 12)
	// A Bun process in every member making auth calls throughout, counted
	// in the same container limit.
	loads := map[string]string{}
	var lmu sync.Mutex
	var lwg sync.WaitGroup
	for _, n := range cluster {
		_ = sh(n, "rm -f /tmp/stop-load")
		lwg.Add(1)
		go func(n Node) {
			defer lwg.Done()
			out, code, err := dexec(n, "bun", "/bench/load.ts", "m-0000042")
			lmu.Lock()
			loads[n.Name] = fmt.Sprintf("%s (exit %d, %v)", strings.TrimSpace(out), code, err)
			lmu.Unlock()
		}(n)
	}
	time.Sleep(3 * time.Second)
	var tput []map[string]any
	for r := 1; r <= rounds; r++ {
		m := bench(L, "run_commit", 5000, 16)
		tput = append(tput, map[string]any{"round": r, "ops_per_s": m["ops_per_s"], "p99_us": m["p99_us"], "errors": m["errors"]})
		must(L, "POST", "/expire-chunk?keep=20000&chunk=500", 10*time.Minute)
		memSnap(fmt.Sprintf("runs %dk", r*5), &rows)
	}
	for _, n := range cluster {
		_ = sh(n, "touch /tmp/stop-load")
	}
	lwg.Wait()
	record("budget_bun_load", loads)
	time.Sleep(30 * time.Second)
	memSnap("settled 30s", &rows)
	state := map[string]any{}
	for _, n := range cluster {
		state[n.Name] = inspect(n)
	}
	record("budget", map[string]any{"limit_mb": limitBytes >> 20, "cpus": 1, "rounds": rounds, "runs": rounds * 5000, "rows_written": rounds * 5000 * 5, "throughput": tput, "containers": state})
	record("budget_memory", rows)
}

func backupRestore() {
	logf("backup: online backup under load, then restore twice onto fresh members")
	s0, _ := status(cluster[0])
	inc0 := s0.Inc
	setWorkers(cluster, true)
	w := startWorkload(cluster, "bk")
	time.Sleep(5 * time.Second)
	L, err := leader(cluster)
	if err != nil {
		die("%v", err)
	}
	tB := time.Now()
	r := must(L, "POST", "/backup?dir=/out/backup", 5*time.Minute)
	var bk struct {
		DumpMs        int64                     `json:"dump_ms"`
		Files         map[string]int            `json:"files"`
		Checksums     map[string]map[string]any `json:"checksums"`
		AllocatorNext int64                     `json:"allocator_next"`
	}
	_ = json.Unmarshal(r.V, &bk)
	logf("backup: dump %d ms, files %v, allocator next %d", bk.DumpMs, bk.Files, bk.AllocatorNext)
	time.Sleep(3 * time.Second)
	w.Stop()
	setWorkers(cluster, false)
	time.Sleep(2 * time.Second)
	nAcks := readAcks(cluster)
	logf("backup: SIGKILL n1-n3 (the whole cluster is lost; their disks are kept)")
	for _, n := range cluster {
		_ = dkill(n, "KILL")
	}

	var checks []Check
	add := func(name string, pass bool, format string, a ...any) {
		c := Check{name, pass, fmt.Sprintf(format, a...)}
		checks = append(checks, c)
		logf("  %v %s: %s", map[bool]string{true: "PASS", false: "FAIL"}[pass], name, c.Detail)
	}
	type round struct {
		inc     string
		acks    []NAck
		wl      *Workload
		restore map[string]any
	}
	var rounds []round
	var oldMember map[string]any
	for rn := 1; rn <= 2; rn++ {
		for _, f := range fresh {
			dremove(f)
		}
		certSet = map[int]string{1: "b", 2: "c"}[rn]
		join := fresh[0].IP + ":9001"
		for i, f := range fresh {
			j := join
			if i == 0 {
				j = ""
			}
			if err := dcreate(f, j); err != nil {
				die("%v", err)
			}
		}
		waitHealthy(fresh, 3*time.Minute)
		t := time.Now()
		rr := must(fresh[0], "POST", "/restore?dir=/out/backup", 10*time.Minute)
		var rs struct {
			ReplayMs  int64                     `json:"replay_ms"`
			Rows      map[string]int            `json:"rows"`
			Checksums map[string]map[string]any `json:"checksums"`
			From      string                    `json:"from_incarnation"`
			Inc       string                    `json:"incarnation"`
		}
		_ = json.Unmarshal(rr.V, &rs)
		restoreMs := time.Since(t).Milliseconds()
		waitIncarnation(fresh, rs.Inc, time.Minute)
		logf("restore %d: %d ms, incarnation %s (from %s)", rn, restoreMs, rs.Inc, rs.From)
		var mismatch []string
		for _, tname := range []string{"sessions", "tokens", "lease_claims", "monitors", "monitor_state", "runs", "results", "outbox", "history_export", "allocators", "link_positions"} {
			if fmt.Sprint(bk.Checksums[tname]) != fmt.Sprint(rs.Checksums[tname]) {
				mismatch = append(mismatch, tname)
			}
		}
		add(fmt.Sprintf("restore %d matches the backup", rn), len(mismatch) == 0 && rs.From == inc0 && rs.Inc != inc0, "row checksums of 11 tables compared, mismatched %v; incarnation %s -> %s", mismatch, rs.From, rs.Inc)

		if rn == 1 {
			R := fresh[0]
			runSet := map[string]bool{}
			for _, x := range q(R, "SELECT run_id FROM runs") {
				runSet[x["run_id"].(string)] = true
			}
			sessSet := map[string]bool{}
			for _, x := range q(R, "SELECT id FROM sessions WHERE id LIKE 'bk-%'") {
				sessSet[x["id"].(string)] = true
			}
			cut := tB.UnixMilli()
			lostRuns, before := 0, 0
			for _, a := range nAcks {
				if a.K == "run" && a.T < cut {
					before++
					if !runSet[a.ID] {
						lostRuns++
					}
				}
			}
			lostS, beforeS, lostB, beforeB := 0, 0, 0, 0
			w.mu.Lock()
			for _, a := range w.created {
				if a.T < cut {
					beforeS++
					if !sessSet[a.ID] {
						lostS++
					}
				}
			}
			for _, b := range w.blocks {
				if b.T < cut {
					beforeB++
					if b.E > bk.AllocatorNext {
						lostB++
					}
				}
			}
			w.mu.Unlock()
			add("no acknowledged write before the backup lost", lostRuns == 0 && lostS == 0 && lostB == 0,
				"acknowledged before the backup began: runs %d (member record), missing %d; sessions %d and arrival blocks %d (runner record), missing %d and %d", before, lostRuns, beforeS, beforeB, lostS, lostB)
		}

		setWorkers(fresh, true)
		wl := startWorkload(fresh, fmt.Sprintf("rs%d", rn))
		time.Sleep(8 * time.Second)
		if rn == 2 {
			oldMember = oldMemberReturns(wl, inc0, rs.Inc)
		}
		wl.Stop()
		setWorkers(fresh, false)
		time.Sleep(2 * time.Second)
		var acks []NAck
		for _, a := range readAcks(fresh) {
			if a.Inc == rs.Inc {
				acks = append(acks, a)
			}
		}
		rounds = append(rounds, round{rs.Inc, acks, wl, map[string]any{"restore_ms": restoreMs, "replay_ms": rs.ReplayMs, "rows": rs.Rows, "incarnation": rs.Inc}})
	}

	// Identities across the lost installation and both restorations of the
	// same backup: an identity is (incarnation, value).
	type idset struct {
		inc    string
		blocks []block
		runs   []string
		claims []string
	}
	sets := []idset{{inc: inc0}}
	for _, a := range nAcks {
		switch a.K {
		case "block":
			sets[0].blocks = append(sets[0].blocks, block{a.S, a.E, a.Node})
		case "run":
			sets[0].runs = append(sets[0].runs, a.ID)
		case "claim":
			sets[0].claims = append(sets[0].claims, fmt.Sprintf("%s/%s/%d", a.Inc, a.Name, a.Gen))
		}
	}
	w.mu.Lock()
	for _, b := range w.blocks {
		sets[0].blocks = append(sets[0].blocks, block{b.S, b.E, "runner"})
	}
	w.mu.Unlock()
	for _, rd := range rounds {
		x := idset{inc: rd.inc}
		for _, a := range rd.acks {
			switch a.K {
			case "block":
				x.blocks = append(x.blocks, block{a.S, a.E, a.Node})
			case "run":
				x.runs = append(x.runs, a.ID)
			case "claim":
				x.claims = append(x.claims, fmt.Sprintf("%s/%s/%d", a.Inc, a.Name, a.Gen))
			}
		}
		rd.wl.mu.Lock()
		for _, b := range rd.wl.blocks {
			if b.Inc == rd.inc {
				x.blocks = append(x.blocks, block{b.S, b.E, "runner"})
			}
		}
		rd.wl.mu.Unlock()
		sets = append(sets, x)
	}
	incs := map[string]bool{}
	within, numericCross, dupRuns, dupClaims := 0, 0, 0, 0
	seenRun, seenClaim := map[string]bool{}, map[string]bool{}
	for i, x := range sets {
		incs[x.inc] = true
		within += overlaps(append([]block(nil), x.blocks...))
		for _, id := range x.runs {
			if seenRun[id] {
				dupRuns++
			}
			seenRun[id] = true
		}
		for _, id := range x.claims {
			if seenClaim[id] {
				dupClaims++
			}
			seenClaim[id] = true
		}
		for j := 0; j < i; j++ {
			numericCross += overlaps(append(append([]block(nil), x.blocks...), sets[j].blocks...)) - overlaps(append([]block(nil), x.blocks...)) - overlaps(append([]block(nil), sets[j].blocks...))
		}
	}
	nBlocks := 0
	for _, x := range sets {
		nBlocks += len(x.blocks)
	}
	add("no identity reused across restores of the same backup", len(incs) == 3 && within == 0 && dupRuns == 0 && dupClaims == 0 && len(sets[1].blocks) > 0 && len(sets[2].blocks) > 0,
		"3 incarnations (%d distinct); %d arrival blocks: %d overlapping within an incarnation; %d run ids and %d claims, %d and %d repeated; %d block ranges reused as numbers across incarnations (expected: the namespace is what keeps them apart)",
		len(incs), nBlocks, within, len(seenRun), len(seenClaim), dupRuns, dupClaims, numericCross)
	if oldMember != nil {
		add("an old member returning is fenced", oldMember["acked_writes_after_return"] == 0 && oldMember["api_write_refused"] == true,
			"old n3 back with its disk while the restored installation answers at n1's and n2's addresses: reached it %v, fenced %v, workers on %v; writes it acknowledged after returning: %v; its API write refused: %v; restored installation's longest write gap meanwhile: %v ms",
			oldMember["ready"], oldMember["fenced"], oldMember["workers_on"], oldMember["acked_writes_after_return"], oldMember["api_write_refused"], oldMember["restored_write_gap_ms"])
	}
	var rinfo []map[string]any
	for _, rd := range rounds {
		rinfo = append(rinfo, rd.restore)
	}
	nAfter := 0
	for _, b := range sets[0].blocks {
		if b.e > bk.AllocatorNext {
			nAfter++
		}
	}
	record("backup", map[string]any{"dump_ms": bk.DumpMs, "files": bk.Files, "restores": rinfo, "blocks_after_dump": nAfter, "incarnation_lost": inc0, "old_member": oldMember})
	record("checks_backup", checks)
}

// oldMemberReturns starts lost member n3 again with its disk. Its peers'
// addresses (n1, n2) now belong to the restored installation.
func oldMemberReturns(wl *Workload, inc0, inc string) map[string]any {
	n3 := cluster[2]
	t := time.Now()
	_ = dstart(n3)
	var s Status
	ready := false
	workersOn := false
	for time.Since(t) < 20*time.Second {
		if st, err := status(n3); err == nil {
			s = st
			if st.Ready {
				ready = true
				// Its workers write with its own (old) incarnation, fenced
				// or not: the database's conditional writes must refuse them.
				if !workersOn {
					_, err := ok(n3, "POST", "/workers?on=1", time.Second)
					workersOn = err == nil
				}
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	_, code, err := call(n3, "POST", fmt.Sprintf("/session?id=old-%d", time.Now().UnixNano()), 2*time.Second)
	refused := err != nil || code != 200
	acked := 0
	for _, a := range readAcks([]Node{n3}) {
		if a.T > t.UnixMilli() {
			acked++
		}
	}
	// Rows it might have written with its own incarnation since returning.
	landed := count(fresh[0], fmt.Sprintf("SELECT count(*) AS c FROM runs WHERE owner = 'n3' AND at > %d", t.UnixMilli()))
	gap := wl.gap(t, time.Now())
	_ = dkill(n3, "KILL")
	out := map[string]any{"ready": ready, "fenced": s.Fenced, "its_incarnation": s.Inc, "lost_incarnation": inc0, "restored_incarnation": inc,
		"acked_writes_after_return": acked + int(landed), "api_write_refused": refused, "restored_write_gap_ms": gap.Milliseconds(), "workers_on": workersOn, "stats": s.Stats}
	b, _ := json.Marshal(out)
	logf("old member returns: %s", b)
	return out
}

// batchTest runs the member's deterministic check of rqlite's conditional
// batches against the live cluster.
func batchTest() {
	L, err := leader(cluster)
	if err != nil {
		die("%v", err)
	}
	r := must(L, "POST", "/selftest/batch", time.Minute)
	var cases []map[string]any
	_ = json.Unmarshal(r.V, &cases)
	var checks []Check
	for _, c := range cases {
		b, _ := json.Marshal(c)
		logf("batch test: %s", b)
		checks = append(checks, Check{"batch: " + fmt.Sprint(c["case"]), c["pass"] == true, fmt.Sprintf("expected %v; error %v", c["expected"], c["error"])})
	}
	record("batch_test", cases)
	record("checks_batch", checks)
}
