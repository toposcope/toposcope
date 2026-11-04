package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
)

type Check struct {
	Name   string `json:"name"`
	Pass   bool   `json:"pass"`
	Detail string `json:"detail"`
}

// NAck is one write a member acknowledged, from its ack file.
type NAck struct {
	K    string `json:"k"`
	Name string `json:"name"`
	Gen  int64  `json:"gen"`
	Node string `json:"node"`
	ID   string `json:"id"`
	M    int64  `json:"m"`
	Pos  int64  `json:"pos"`
	Inc  string `json:"inc"`
	S    int64  `json:"s"`
	E    int64  `json:"e"`
	T    int64  `json:"t"`
}

func readAcks(set []Node) []NAck {
	var out []NAck
	for _, n := range set {
		f, err := os.Open("/out/acks/" + n.Name + ".jsonl")
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 1<<20), 1<<20)
		for sc.Scan() {
			var a NAck
			if json.Unmarshal(sc.Bytes(), &a) == nil {
				out = append(out, a)
			}
		}
		f.Close()
	}
	return out
}

func count(n Node, sql string) int64 {
	rows := q(n, sql)
	if len(rows) == 0 {
		return -1
	}
	return num(rows[0]["c"])
}

type block struct {
	s, e int64
	node string
}

// overlaps returns the number of overlapping pairs among blocks.
func overlaps(bs []block) int {
	sort.Slice(bs, func(i, j int) bool { return bs[i].s < bs[j].s })
	bad := 0
	for i := 1; i < len(bs); i++ {
		if bs[i].s < bs[i-1].e {
			bad++
		}
	}
	return bad
}

func blocksOf(acks []NAck) []block {
	var out []block
	for _, a := range acks {
		if a.K == "block" {
			out = append(out, block{a.S, a.E, a.Node})
		}
	}
	return out
}

func verify(w *Workload) {
	L, err := leader(cluster)
	if err != nil {
		die("%v", err)
	}
	acks := readAcks(cluster)
	var checks []Check
	add := func(name string, pass bool, format string, a ...any) {
		c := Check{name, pass, fmt.Sprintf(format, a...)}
		checks = append(checks, c)
		mark := "PASS"
		if !pass {
			mark = "FAIL"
		}
		logf("  %s %s: %s", mark, name, c.Detail)
	}
	kinds := map[string]int{}
	for _, a := range acks {
		kinds[a.K]++
	}
	logf("verify: %d acks from members %v", len(acks), kinds)

	// Ownership claims.
	claimOwner := map[string]string{}
	gensByName := map[string][]int64{}
	for _, r := range q(L, "SELECT name, gen, owner FROM lease_claims WHERE name IN ('scheduler', 'link:peer-a') ORDER BY name, gen") {
		name := r["name"].(string)
		claimOwner[fmt.Sprintf("%s/%d", name, num(r["gen"]))] = r["owner"].(string)
		gensByName[name] = append(gensByName[name], num(r["gen"]))
	}
	gaps := 0
	for _, gs := range gensByName {
		for i, g := range gs {
			if g != int64(i+1) {
				gaps++
			}
		}
	}
	dupClaims, lostClaims := 0, 0
	seen := map[string]string{}
	nClaims := 0
	for _, a := range acks {
		if a.K != "claim" {
			continue
		}
		nClaims++
		key := fmt.Sprintf("%s/%d", a.Name, a.Gen)
		if prev, ok := seen[key]; ok && prev != a.Node {
			dupClaims++
		}
		seen[key] = a.Node
		owner, ok := claimOwner[key]
		if !ok {
			lostClaims++
		} else if owner != a.Node {
			dupClaims++
		}
	}
	add("no duplicate claims", dupClaims == 0 && gaps == 0, "%d acknowledged claims across %d generations (scheduler %d, link %d); %d claimed twice; %d generation gaps",
		nClaims, len(claimOwner), len(gensByName["scheduler"]), len(gensByName["link:peer-a"]), dupClaims, gaps)

	// Stale owners: every committed run carries the generation that was
	// current, by its owner, and generations never go backwards.
	runs := q(L, "SELECT rowid AS r, run_id, gen, owner FROM runs WHERE run_id NOT LIKE 'bench-%' ORDER BY rowid")
	backwards, wrongOwner := 0, 0
	var maxGen int64
	runSet := map[string]bool{}
	for _, r := range runs {
		g := num(r["gen"])
		if g < maxGen {
			backwards++
		}
		if g > maxGen {
			maxGen = g
		}
		if claimOwner[fmt.Sprintf("scheduler/%d", g)] != r["owner"] {
			wrongOwner++
		}
		runSet[r["run_id"].(string)] = true
	}
	linkWrong := 0
	var linkPos []int64
	for _, a := range acks {
		if a.K == "link" {
			if claimOwner[fmt.Sprintf("link:peer-a/%d", a.Gen)] != a.Node {
				linkWrong++
			}
			linkPos = append(linkPos, a.Pos)
		}
	}
	add("stale owner's write refused", backwards == 0 && wrongOwner == 0 && linkWrong == 0,
		"%d committed runs: %d with an older generation after a newer one, %d by a member that did not hold that generation; %d link advances by a non-owner", len(runs), backwards, wrongOwner, linkWrong)

	// Positions.
	blocks := blocksOf(acks)
	w.mu.Lock()
	runnerBlocks := len(w.blocks)
	for _, b := range w.blocks {
		blocks = append(blocks, block{b.S, b.E, "runner"})
	}
	w.mu.Unlock()
	ov := overlaps(blocks)
	next := num(q(L, "SELECT next AS c FROM allocators WHERE name = 'arrival'")[0]["c"])
	beyond := 0
	for _, b := range blocks {
		if b.e > next {
			beyond++
		}
	}
	sort.Slice(linkPos, func(i, j int) bool { return linkPos[i] < linkPos[j] })
	dupPos := 0
	for i := 1; i < len(linkPos); i++ {
		if linkPos[i] == linkPos[i-1] {
			dupPos++
		}
	}
	finalLink := num(q(L, "SELECT position AS c FROM link_positions WHERE link = 'peer-a'")[0]["c"])
	linkBeyond := 0
	if len(linkPos) > 0 && linkPos[len(linkPos)-1] > finalLink {
		linkBeyond = 1
	}
	add("no reused positions", ov == 0 && beyond == 0 && dupPos == 0 && linkBeyond == 0,
		"%d acknowledged arrival blocks of 1000 (%d recorded at the runner, the rest by members): %d overlapping, %d past the allocator (next %d); %d link advances: %d repeated, final position %d",
		len(blocks), runnerBlocks, ov, beyond, next, len(linkPos), dupPos, finalLink)

	// Acknowledged writes all present.
	sess := map[string]bool{}
	for _, r := range q(L, "SELECT id, revoked_at FROM sessions WHERE id LIKE 'w-%'") {
		sess[r["id"].(string)] = r["revoked_at"] != nil
	}
	w.mu.Lock()
	lostS, lostR := 0, 0
	for _, a := range w.created {
		if _, ok := sess[a.ID]; !ok {
			lostS++
		}
	}
	for _, a := range w.revoked {
		if !sess[a.ID] {
			lostR++
		}
	}
	nS, nR := len(w.created), len(w.revoked)
	w.mu.Unlock()
	lostRuns, nRuns := 0, 0
	for _, a := range acks {
		if a.K == "run" {
			nRuns++
			if !runSet[a.ID] {
				lostRuns++
			}
		}
	}
	add("no lost acknowledged write", lostS == 0 && lostR == 0 && lostRuns == 0 && lostClaims == 0,
		"sessions %d acked / %d missing; revocations %d / %d not applied; monitor runs %d / %d missing; claims %d / %d missing",
		nS, lostS, nR, lostR, nRuns, lostRuns, nClaims, lostClaims)

	// A run is all or nothing.
	partial := count(L, "SELECT count(*) AS c FROM runs r WHERE run_id NOT LIKE 'bench-%' AND (NOT EXISTS (SELECT 1 FROM results x WHERE x.run_id = r.run_id) OR NOT EXISTS (SELECT 1 FROM outbox o WHERE o.run_id = r.run_id) OR NOT EXISTS (SELECT 1 FROM history_export h WHERE h.run_id = r.run_id))")
	orphans := count(L, "SELECT (SELECT count(*) FROM results WHERE run_id NOT IN (SELECT run_id FROM runs)) + (SELECT count(*) FROM outbox WHERE run_id NOT IN (SELECT run_id FROM runs)) + (SELECT count(*) FROM history_export WHERE run_id NOT IN (SELECT run_id FROM runs)) AS c")
	versions := count(L, "SELECT count(*) AS c FROM monitor_state m WHERE version <> (SELECT count(*) FROM runs r WHERE r.monitor_id = m.monitor_id)")
	add("monitor run is one transaction", partial == 0 && orphans == 0 && versions == 0,
		"%d runs missing a result, call or history row; %d orphan rows; %d monitors whose state version is not their run count", partial, orphans, versions)

	record("checks_faults", checks)
}

func revocationCheck() Check {
	resMu.Lock()
	trials, _ := results["revocation_trials"].([]RevTrial)
	resMu.Unlock()
	var max int64
	proven, majority, afterHeal := 0, 0, 0
	for _, t := range trials {
		if t.StaleWindowMs > max {
			max = t.StaleWindowMs
		}
		proven += t.ProvenStaleReads
		majority += t.MajorityStaleReads
		if t.ValidAfterHeal {
			afterHeal++
		}
	}
	bound := int64(2 * electionMs)
	var parts []string
	parts = append(parts, fmt.Sprintf("%d trials; longest time the isolated old leader still answered valid after the revocation was sent: %d ms (bound 2 x election timeout = %d ms)", len(trials), max, bound))
	parts = append(parts, fmt.Sprintf("%d reads sent after the revocation's ack answered valid there", proven))
	parts = append(parts, fmt.Sprintf("%d stale answers on the majority, %d after heal", majority, afterHeal))
	return Check{"revocation visible everywhere within bound", len(trials) > 0 && max <= bound && majority == 0 && afterHeal == 0, strings.Join(parts, "; ")}
}
