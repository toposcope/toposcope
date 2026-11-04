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
		out = append(out, revocationCheck())
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
	out = append(out, bk...)
	return out
}

// memoryCheck: bounded means RSS stops growing once the live set stops
// growing. The live set is constant from the first tenth of the churn on,
// so RSS at the end of the churn must be within 25% of RSS at 30%.
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
	b.WriteString("# dqlite proof: run report (" + label + ")\n\n")
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
