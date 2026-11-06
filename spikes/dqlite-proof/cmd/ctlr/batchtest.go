package main

// A deterministic check of the conditional batches, against the live
// cluster: each refused operation must leave no trace, a repeated
// operation id must apply once, and a failure in the middle of a batch must
// undo the statements before it. The last case shows why every batch goes
// with ?transaction.

import (
	"context"
	"errors"
	"fmt"
	"time"
)

type footprint struct {
	Runs, Results, Outbox, History, Version, Claims, LeaseGen, AllocNext, LinkPos int64
}

func (s *Server) footprint(ctx context.Context, st *Store, runID string) (footprint, error) {
	r, err := st.rq.Query(ctx, Linearizable,
		S(`SELECT count(*) FROM runs WHERE run_id = ?`, runID),
		S(`SELECT count(*) FROM results WHERE run_id = ?`, runID),
		S(`SELECT count(*) FROM outbox WHERE run_id = ?`, runID),
		S(`SELECT count(*) FROM history_export WHERE run_id = ?`, runID),
		S(`SELECT version FROM monitor_state WHERE monitor_id = 1`),
		S(`SELECT count(*) FROM lease_claims WHERE name = 'bt:sched'`),
		S(`SELECT gen FROM leases WHERE name = 'bt:sched'`),
		S(`SELECT next FROM allocators WHERE name = 'arrival'`),
		S(`SELECT position FROM link_positions WHERE link = 'bt:link'`),
	)
	if err != nil {
		return footprint{}, err
	}
	v := func(i int) int64 {
		x, _ := One(r[i : i+1])
		n, _ := x.(int64)
		return n
	}
	return footprint{v(0), v(1), v(2), v(3), v(4), v(5), v(6), v(7), v(8)}, nil
}

func (s *Server) batchTest(_ context.Context, st *Store, _ map[string]string) (any, error) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	inc := s.localInc()
	tag := fmt.Sprintf("bt%d", time.Now().UnixNano())
	// Setup: this member owns bt:sched and bt:link.
	if _, err := st.rq.Exec(ctx,
		S(`INSERT OR IGNORE INTO leases (name, owner, gen, expires_at) VALUES ('bt:sched', NULL, 0, 0)`),
		S(`INSERT OR IGNORE INTO leases (name, owner, gen, expires_at) VALUES ('bt:link', NULL, 0, 0)`),
		S(`UPDATE leases SET owner = NULL, expires_at = 0 WHERE name IN ('bt:sched', 'bt:link')`),
		S(`INSERT OR IGNORE INTO link_positions (link, position, gen) VALUES ('bt:link', 0, 0)`),
	); err != nil {
		return nil, fmt.Errorf("setup: %w", err)
	}
	gen, err := st.Claim(ctx, inc, "bt:sched", 3600_000)
	if err != nil {
		return nil, fmt.Errorf("claim: %w", err)
	}
	lgen, err := st.Claim(ctx, inc, "bt:link", 3600_000)
	if err != nil {
		return nil, fmt.Errorf("claim link: %w", err)
	}

	var cases []map[string]any
	run := func(name, want string, runID string, fn func() error, check func(before, after footprint, err error) bool) {
		before, _ := s.footprint(ctx, st, runID)
		err := fn()
		after, _ := s.footprint(ctx, st, runID)
		pass := check(before, after, err)
		cases = append(cases, map[string]any{"case": name, "expected": want, "error": fmt.Sprint(err), "before": before, "after": after, "pass": pass})
	}
	untouched := func(b, a footprint) bool { return b == a }

	id := tag + "-stale"
	run("stale generation", "refused, no trace", id, func() error {
		return st.CommitRun(ctx, inc, "bt:sched", gen-1, 1, id, true)
	}, func(b, a footprint, err error) bool { return errors.Is(err, errStale) && untouched(b, a) })

	id = tag + "-inc"
	run("wrong incarnation", "refused, no trace", id, func() error {
		return st.CommitRun(ctx, "0000000000000000", "bt:sched", gen, 1, id, true)
	}, func(b, a footprint, err error) bool { return errors.Is(err, errStale) && untouched(b, a) })

	id = tag + "-ok"
	run("current owner", "applied: run, result, state, call, history", id, func() error {
		return st.CommitRun(ctx, inc, "bt:sched", gen, 1, id, true)
	}, func(b, a footprint, err error) bool {
		return err == nil && a.Runs == 1 && a.Results == 1 && a.Outbox == 1 && a.History == 1 && a.Version == b.Version+1
	})

	run("same operation id again, a new request", "refused as duplicate, applied once", id, func() error {
		return st.CommitRun(ctx, inc, "bt:sched", gen, 1, id, true)
	}, func(b, a footprint, err error) bool { return errors.Is(err, errDuplicate) && untouched(b, a) })

	run("same operation id again, as a repeat after an unknown outcome", "answered done, applied once", id, func() error {
		return st.commitRunAttempt(ctx, 2, st.commitRunStmts(inc, "bt:sched", gen, 1, id, true), id, gen, inc)
	}, func(b, a footprint, err error) bool { return err == nil && untouched(b, a) })

	id = tag + "-mid1"
	run("failure midway: monitor missing (statement 6 of 8)", "nothing applied", id, func() error {
		return st.CommitRun(ctx, inc, "bt:sched", gen, 999999, id, true)
	}, func(b, a footprint, err error) bool {
		var se *SQLError
		return errors.As(err, &se) && untouched(b, a)
	})

	id = tag + "-mid2"
	run("failure midway: outbox call id taken (statement 7 of 8)", "nothing applied", id, func() error {
		if _, err := st.rq.Exec(ctx, S(`INSERT INTO outbox (call_id, run_id, payload, created_at) VALUES (?, 'other', '{}', 0)`, id+":call")); err != nil {
			return err
		}
		return st.CommitRun(ctx, inc, "bt:sched", gen, 1, id, true)
	}, func(b, a footprint, err error) bool {
		var se *SQLError
		return errors.As(err, &se) && a.Runs == 0 && a.Results == 0 && a.History == 0 && a.Version == b.Version
	})

	run("claim of a held lease", "refused, generation and claims unchanged", "", func() error {
		_, err := st.Claim(ctx, inc, "bt:sched", 3600_000)
		return err
	}, func(b, a footprint, err error) bool { return errors.Is(err, errHeld) && untouched(b, a) })

	run("allocation with a wrong incarnation", "refused, allocator unchanged", "", func() error {
		_, _, err := st.AllocBlock(ctx, "0000000000000000", 1000)
		return err
	}, func(b, a footprint, err error) bool { return errors.Is(err, errStale) && untouched(b, a) })

	run("link advance with an old generation", "refused, position unchanged", "", func() error {
		_, err := st.AdvanceLink(ctx, inc, "bt:link", "bt:link", tag+"-l0", lgen-1, 10)
		return err
	}, func(b, a footprint, err error) bool { return errors.Is(err, errStale) && untouched(b, a) })

	var p1, p2 int64
	run("link advance", "applied once", "", func() error {
		var err error
		p1, err = st.AdvanceLink(ctx, inc, "bt:link", "bt:link", tag+"-l1", lgen, 10)
		return err
	}, func(b, a footprint, err error) bool {
		return err == nil && a.LinkPos == b.LinkPos+10 && p1 == a.LinkPos
	})

	run("link advance, same operation id again", "answers the same position, no second move", "", func() error {
		var err error
		p2, err = st.AdvanceLink(ctx, inc, "bt:link", "bt:link", tag+"-l1", lgen, 10)
		return err
	}, func(b, a footprint, err error) bool { return err == nil && untouched(b, a) && p2 == p1 })

	id = tag + "-loose"
	run("the same refused batch WITHOUT ?transaction", "statements after the failed one still commit (why Exec always sets it)", id, func() error {
		stmts := st.commitRunStmts(inc, "bt:sched", gen-1, 1, id, true)
		_, err := st.rq.ExecLoose(ctx, stmts...)
		return err
	}, func(b, a footprint, err error) bool {
		// Expected to be unsafe: the check passes when it reproduces that.
		return errors.Is(err, errStale) && (a.Runs == 1 || a.Results == 1 || a.Version != b.Version)
	})

	// Leave nothing behind for the workload's checks.
	like := tag + "%"
	_, _ = st.rq.Exec(ctx,
		S(`UPDATE leases SET owner = NULL, expires_at = 0 WHERE name IN ('bt:sched', 'bt:link')`),
		S(`DELETE FROM runs WHERE run_id LIKE ?`, like),
		S(`DELETE FROM results WHERE run_id LIKE ?`, like),
		S(`DELETE FROM outbox WHERE run_id LIKE ? OR call_id LIKE ?`, like, like),
		S(`DELETE FROM history_export WHERE run_id LIKE ?`, like),
		S(`UPDATE monitor_state SET version = (SELECT count(*) FROM runs WHERE monitor_id = 1) WHERE monitor_id = 1`))
	return cases, nil
}
