package main

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// criteria gathers every pass/fail into one list.
func criteria() []Check {
	resMu.Lock()
	var out []Check
	if c, ok := results["checks_guard"].([]Check); ok {
		out = append(out, c...)
	}
	if c, ok := results["checks_batch"].([]Check); ok {
		out = append(out, c...)
	}
	if c, ok := results["checks_snapstall"].([]Check); ok {
		out = append(out, c...)
	}
	if c, ok := results["checks_faults"].([]Check); ok {
		out = append(out, c...)
	}
	_, haveRev := results["revocation_trials"]
	fp, haveFP := results["follower_partition"].(map[string]any)
	pauses, _ := results["pause_trials"].([]map[string]any)
	mem, _ := results["memory"].([]MemRow)
	bk, _ := results["checks_backup"].([]Check)
	resMu.Unlock()
	if haveRev {
		out = append(out, revocationCheck(), strictRevocationCheck(), majorityCommitsCheck())
	}
	if haveFP {
		v, wr := fp["answered_valid_after_revoke"].(int), fp["writes_committed_on_lone_follower"].(int)
		out = append(out, Check{"lone member commits nothing, answers no revoked session", v == 0 && wr == 0,
			fmt.Sprintf("isolated follower: %d of %d reads answered valid after the revocation, %d of 5 writes committed", v, fp["reads_on_lone_follower"], wr)})
	}
	if len(pauses) > 0 {
		refused := int64(0)
		for _, p := range pauses {
			// Every write refused under an old generation gives the lease up.
			refused += p["leases_given_up_after_resume"].(int64)
		}
		out = append(out, Check{"paused owner's old generation was exercised", refused > 0,
			fmt.Sprintf("%d pauses; after SIGCONT the old owners attempted writes under their old generation and %d were refused (the committed-run check above shows none landed)", len(pauses), refused)})
	}
	if len(mem) > 0 {
		out = append(out, memoryCheck(mem))
	}
	resMu.Lock()
	bmem, _ := results["budget_memory"].([]MemRow)
	budget, _ := results["budget"].(map[string]any)
	resMu.Unlock()
	if len(bmem) > 0 {
		out = append(out, budgetCheck(bmem, budget))
	}
	if len(pauses) > 0 {
		slow := 0
		for _, p := range pauses {
			if t, _ := p["takeover_ms"].(int64); t < 0 || t > 10000 {
				slow++
			}
		}
		out = append(out, Check{"every lease takeover within 10 s", slow == 0, fmt.Sprintf("%d of %d pauses took longer or had none", slow, len(pauses))})
	}
	out = append(out, bk...)
	return out
}

// memoryCheck: bounded means RSS stops growing once the live set stops
// growing. The live set is constant from the first tenth of the churn on,
// so RSS at the end of the churn must be within 25% of RSS at 30%.
// budgetCheck: the member fits the app container's limit with half of it
// left for Bun, never OOM-killed, and RSS levels off across the cleanup
// cycles (end within 25% of the value at a third of the way).
func budgetCheck(rows []MemRow, b map[string]any) Check {
	limit := int64(512 << 10) // KB
	var peak, cgPeak, bunPeak int64
	at := map[string]map[string]int64{}
	for _, r := range rows {
		if r.HWMKB > peak {
			peak = r.HWMKB
		}
		cgPeak, bunPeak = max(cgPeak, r.CgPeakKB), max(bunPeak, r.BunKB)
		if at[r.Stage] == nil {
			at[r.Stage] = map[string]int64{}
		}
		at[r.Stage][r.Node] = r.RSSKB
	}
	rounds, _ := b["rounds"].(int)
	early, late := fmt.Sprintf("runs %dk", (rounds/3)*5), fmt.Sprintf("runs %dk", rounds*5)
	level := true
	var parts []string
	for _, n := range cluster {
		e, l := at[early][n.Name], at[late][n.Name]
		if e == 0 || float64(l) > 1.25*float64(e) {
			level = false
		}
		parts = append(parts, fmt.Sprintf("%s %d -> %d MB", n.Name, e/1024, l/1024))
	}
	oom := false
	if cs, ok := b["containers"].(map[string]any); ok {
		for _, v := range cs {
			if m, _ := v.(map[string]any); m["oom_killed"] == true || m["running"] != true {
				oom = true
			}
		}
	}
	return Check{"fits the app container's budget (512 MB, 1 CPU)", !oom && peak <= limit/2 && level,
		fmt.Sprintf("peak RSS of the storage side (Go service and database, every process) %d MB of 512 (pass if at most half, leaving the rest for Bun); whole container with a Bun auth client running: cgroup peak %d MB, Bun RSS %d MB; OOM or stopped: %v; RSS from %s to %s: %s", peak/1024, cgPeak/1024, bunPeak/1024, oom, early, late, strings.Join(parts, ", "))}
}

func memoryCheck(rows []MemRow) Check {
	at := func(stage, node string) int64 {
		for _, r := range rows {
			if r.Stage == stage && r.Node == node {
				return r.RSSKB
			}
		}
		return 0
	}
	early := fmt.Sprintf("churn %dk", churnBatches*3/10)
	late := fmt.Sprintf("churn %dk", churnBatches)
	pass := true
	var parts []string
	for _, n := range cluster {
		e, l := at(early, n.Name), at(late, n.Name)
		if e == 0 || l == 0 || float64(l) > 1.25*float64(e) {
			pass = false
		}
		parts = append(parts, fmt.Sprintf("%s %d -> %d MB", n.Name, e/1024, l/1024))
	}
	return Check{"memory bounded", pass, fmt.Sprintf("RSS from %s to %s rows: %s (limit +25%%)", early, late, strings.Join(parts, ", "))}
}

func report(res map[string]any, crit []Check) string {
	var b strings.Builder
	b.WriteString("# " + backend + " proof: run report (" + label + ")\n\n")
	if f, ok := res["fatal"]; ok {
		fmt.Fprintf(&b, "**Run stopped early:** %v\n\n", f)
	}
	b.WriteString("## Criteria\n\n| Criterion | Result | Detail |\n| --- | --- | --- |\n")
	for _, c := range crit {
		fmt.Fprintf(&b, "| %s | %s | %s |\n", c.Name, map[bool]string{true: "PASS", false: "**FAIL**"}[c.Pass], c.Detail)
	}
	// Everything else, generically.
	raw, _ := json.Marshal(res)
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	keys := make([]string, 0, len(m))
	for k := range m {
		if !strings.HasPrefix(k, "checks_") && k != "criteria" {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	for _, k := range keys {
		fmt.Fprintf(&b, "\n## %s\n\n", k)
		switch v := m[k].(type) {
		case []any:
			table(&b, v)
		default:
			j, _ := json.MarshalIndent(v, "", "  ")
			b.WriteString("```json\n" + string(j) + "\n```\n")
		}
	}
	return b.String()
}

func table(b *strings.Builder, rows []any) {
	colSet := map[string]bool{}
	var cols []string
	for _, r := range rows {
		if m, ok := r.(map[string]any); ok {
			for k := range m {
				if !colSet[k] {
					colSet[k] = true
					cols = append(cols, k)
				}
			}
		}
	}
	sort.Strings(cols)
	b.WriteString("| " + strings.Join(cols, " | ") + " |\n|" + strings.Repeat(" --- |", len(cols)) + "\n")
	for _, r := range rows {
		m, _ := r.(map[string]any)
		var cells []string
		for _, c := range cols {
			v := m[c]
			s := fmt.Sprint(v)
			if v == nil {
				s = ""
			}
			if o, ok := v.(map[string]any); ok {
				j, _ := json.Marshal(o)
				s = string(j)
			}
			cells = append(cells, strings.ReplaceAll(s, "|", "/"))
		}
		b.WriteString("| " + strings.Join(cells, " | ") + " |\n")
	}
}
