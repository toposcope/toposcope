package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

var benchOps = []string{"session_check", "token_check", "session_create", "session_revoke", "lease_claim", "lease_renew", "run_commit", "block_alloc", "link_advance"}

func bench(n Node, op string, count, conc int) map[string]any {
	r := must(n, "POST", fmt.Sprintf("/bench?op=%s&n=%d&conc=%d", op, count, conc), 10*time.Minute)
	var m map[string]any
	_ = json.Unmarshal(r.V, &m)
	return m
}

// latency measures each operation inside the Go service, called on the
// leader and on a follower (whose driver forwards to the leader).
func latency() {
	L, err := leader(cluster)
	if err != nil {
		die("%v", err)
	}
	F := others(L, cluster)[0]
	var rows []map[string]any
	for _, via := range []struct {
		n    Node
		role string
	}{{L, "leader"}, {F, "follower"}} {
		for _, op := range benchOps {
			m := bench(via.n, op, 1000, 1)
			m["via"] = via.role
			rows = append(rows, m)
			logf("latency %s via %s: p50 %v us p99 %v us errors %v", op, via.role, m["p50_us"], m["p99_us"], m["errors"])
		}
	}
	for _, op := range []string{"session_check", "session_create", "run_commit", "block_alloc"} {
		m := bench(L, op, 4000, 16)
		m["via"] = "leader, 16 concurrent"
		rows = append(rows, m)
		logf("throughput %s x16: %v ops/s p99 %v us", op, m["ops_per_s"], m["p99_us"])
	}
	record("latency", rows)
}

type MemRow struct {
	Stage    string `json:"stage"`
	Node     string `json:"node"`
	RSSKB    int64  `json:"rss_kb"`
	HWMKB    int64  `json:"hwm_kb"`
	GoHeapKB int64  `json:"go_heap_kb"`
	DBKB     int64  `json:"db_kb"`
	FreeKB   int64  `json:"free_kb"`
	DiskKB   int64  `json:"raft_dir_kb"`
}

func memSnap(stage string, rows *[]MemRow) {
	for _, n := range cluster {
		r, err := ok(n, "GET", "/mem", 30*time.Second)
		if err != nil {
			logf("mem %s: %v", n.Name, err)
			continue
		}
		var m map[string]any
		_ = json.Unmarshal(r.V, &m)
		s, _ := status(n)
		ps := num(m["page_size"])
		row := MemRow{stage, n.Name, num(m["rss_kb"]), num(m["hwm_kb"]), s.GoHeap, num(m["page_count"]) * ps / 1024, num(m["freelist_count"]) * ps / 1024, num(m["data_dir_kb"])}
		*rows = append(*rows, row)
	}
	var parts []string
	for _, r := range (*rows)[len(*rows)-len(cluster):] {
		parts = append(parts, fmt.Sprintf("%s rss %d MB db %d MB disk %d MB", r.Node, r.RSSKB/1024, r.DBKB/1024, r.DiskKB/1024))
	}
	logf("mem %-14s %s", stage, strings.Join(parts, " | "))
}

func memory() {
	L, err := leader(cluster)
	if err != nil {
		die("%v", err)
	}
	F := others(L, cluster)[0]
	var rows []MemRow
	memSnap("start", &rows)
	t := time.Now()
	must(L, "POST", "/seed?sessions=50000&monitors=10000&tokens=5000", 10*time.Minute)
	record("seed_ms", time.Since(t).Milliseconds())
	memSnap("seeded", &rows)
	counts := must(L, "GET", "/mem?counts=1", time.Minute)
	record("seeded_counts", counts.V)

	socketBench(L, F)

	logf("churn: %d batches of 1000 outbox + 1000 history rows, expiry keeps the newest 20000", churnBatches)
	var churnUS []int64
	t = time.Now()
	for b := 0; b < churnBatches; b++ {
		r := must(L, "POST", fmt.Sprintf("/churn?n=1000&batch=%d", b), time.Minute)
		churnUS = append(churnUS, r.US)
		if b%10 == 9 {
			must(L, "POST", "/expire?keep=20000", time.Minute)
		}
		if (b+1)%(churnBatches/10) == 0 {
			memSnap(fmt.Sprintf("churn %dk", b+1), &rows)
		}
	}
	record("churn", map[string]any{"batches": churnBatches, "rows_written": churnBatches * 2000, "wall_s": int(time.Since(t).Seconds()), "batch_us": pctInts(churnUS)})
	must(L, "POST", "/expire?keep=0", time.Minute)
	memSnap("expired", &rows)
	if _, err := ok(L, "POST", "/vacuum", 5*time.Minute); err != nil {
		record("vacuum_error", err.Error())
		logf("vacuum: %v", err)
	}
	memSnap("vacuum", &rows)
	time.Sleep(30 * time.Second)
	memSnap("settled 30s", &rows)
	record("memory", rows)
	record("final_counts", must(L, "GET", "/mem?counts=1", time.Minute).V)
}

func pctInts(v []int64) map[string]int64 {
	if len(v) == 0 {
		return nil
	}
	s := append([]int64(nil), v...)
	sortInts(s)
	p := func(q float64) int64 {
		i := int(q * float64(len(s)))
		if i >= len(s) {
			i = len(s) - 1
		}
		return s[i]
	}
	return map[string]int64{"p50": p(0.5), "p95": p(0.95), "p99": p(0.99), "max": s[len(s)-1]}
}

func sortInts(s []int64) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

// socketBench runs the Bun client in a member: today's in-process
// bun:sqlite read against the Unix-socket call to Go.
func socketBench(L, F Node) {
	var out []map[string]any
	for _, x := range []struct {
		n    Node
		role string
	}{{L, "leader"}, {F, "follower"}} {
		s, code, err := dexec(x.n, "bun", "/bench/auth.ts", "m-0000042")
		if err != nil || code != 0 {
			logf("socket bench on %s failed: %v %d %s", x.n.Name, err, code, s)
			continue
		}
		var m map[string]any
		for _, line := range strings.Split(s, "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "{") {
				_ = json.Unmarshal([]byte(line), &m)
			}
		}
		m["via"] = x.role
		out = append(out, m)
		b, _ := json.Marshal(m)
		logf("socket bench via %s: %s", x.role, b)
	}
	record("socket", out)
}

func backupRestore() {
	logf("backup: online backup under load, then restore onto fresh members")
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
	acks := readAcks(cluster)
	logf("backup: SIGKILL n1-n3 (the whole cluster is lost)")
	for _, n := range cluster {
		_ = dkill(n, "KILL")
	}

	waitHealthy(fresh, 3*time.Minute)
	t := time.Now()
	rr := must(fresh[0], "POST", "/restore?dir=/out/backup&bump=1000000000000", 10*time.Minute)
	var rs struct {
		ReplayMs  int64                     `json:"replay_ms"`
		Rows      map[string]int            `json:"rows"`
		Checksums map[string]map[string]any `json:"checksums"`
	}
	_ = json.Unmarshal(rr.V, &rs)
	restoreMs := time.Since(t).Milliseconds()
	logf("restore: %d ms, rows %v", restoreMs, rs.Rows)

	var checks []Check
	add := func(name string, pass bool, format string, a ...any) {
		c := Check{name, pass, fmt.Sprintf(format, a...)}
		checks = append(checks, c)
		logf("  %v %s: %s", map[bool]string{true: "PASS", false: "FAIL"}[pass], name, c.Detail)
	}
	mismatch := []string{}
	for _, tname := range []string{"sessions", "tokens", "lease_claims", "monitors", "monitor_state", "runs", "results", "outbox", "history_export", "link_positions"} {
		a, b := bk.Checksums[tname], rs.Checksums[tname]
		if fmt.Sprint(a) != fmt.Sprint(b) {
			mismatch = append(mismatch, tname)
		}
	}
	add("restore matches the backup", len(mismatch) == 0, "row checksums of %d tables compared; mismatched: %v", 10, mismatch)

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
	for _, a := range acks {
		if a.K == "run" && a.T < cut {
			before++
			if !runSet[a.ID] {
				lostRuns++
			}
		}
	}
	lostS, beforeS := 0, 0
	w.mu.Lock()
	for _, a := range w.created {
		if a.T < cut {
			beforeS++
			if !sessSet[a.ID] {
				lostS++
			}
		}
	}
	w.mu.Unlock()
	add("no acknowledged write before the backup lost", lostRuns == 0 && lostS == 0, "runs acked before the backup began: %d, missing %d; sessions: %d, missing %d", before, lostRuns, beforeS, lostS)

	nBlocks := blocksOf(acks)
	after := 0
	for _, b := range nBlocks {
		if b.e > bk.AllocatorNext {
			after++
		}
	}
	logf("restore: %d blocks were handed out after the dump; a restore without the fence would hand them out again", after)

	setWorkers(fresh, true)
	time.Sleep(8 * time.Second)
	setWorkers(fresh, false)
	time.Sleep(2 * time.Second)
	racks := readAcks(fresh)
	rBlocks := blocksOf(racks)
	var maxN, minR int64
	for _, a := range acks {
		if a.K == "claim" && a.Gen > maxN {
			maxN = a.Gen
		}
	}
	minR = -1
	rRuns := 0
	for _, a := range racks {
		if a.K == "claim" && (minR < 0 || a.Gen < minR) {
			minR = a.Gen
		}
		if a.K == "run" {
			rRuns++
		}
	}
	ov := overlaps(append(append([]block(nil), nBlocks...), rBlocks...))
	add("no reused positions or generations after restore", ov == 0 && len(rBlocks) > 0 && minR > maxN && rRuns > 0,
		"%d blocks handed out after the dump on the old cluster; %d blocks on the restored cluster; %d overlaps; old max generation %d, restored min %d; %d runs committed after restore",
		after, len(rBlocks), ov, maxN, minR, rRuns)

	record("backup", map[string]any{"dump_ms": bk.DumpMs, "files": bk.Files, "restore_ms": restoreMs, "replay_ms": rs.ReplayMs, "rows": rs.Rows, "blocks_after_dump": after})
	record("checks_backup", checks)
}
