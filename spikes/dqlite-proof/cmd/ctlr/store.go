package main

// The same Toposcope-shaped operations as cmd/ctl, on rqlite. rqlite has no
// interactive transactions, so each operation that changes several rows is
// one request of statements run with ?transaction: all of them apply or
// none do. That alone is not a conditional write (an UPDATE that matches no
// row is not an error), so every precondition is an assertion:
//
//	INSERT INTO must (ok, why) VALUES (<condition>, 'stale')
//
// must is a view whose INSTEAD OF triggers raise ABORT with the reason when
// ok is false, which fails the statement and so rolls the whole request
// back. (One trigger per fixed reason: RAISE with a computed message needs
// SQLite 3.48, newer than the system SQLite that opens a backup file.)
// changes() after an UPDATE asserts that it matched. Every value that would
// differ between members (time, random ids) is computed here and passed as
// an argument, because rqlite replicates statements, not pages.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"time"
)

const schema = `
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE TABLE IF NOT EXISTS tokens (id TEXT PRIMARY KEY, hash TEXT NOT NULL, generation INTEGER NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE TABLE IF NOT EXISTS leases (name TEXT PRIMARY KEY, owner TEXT, gen INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS lease_claims (name TEXT NOT NULL, gen INTEGER NOT NULL, owner TEXT NOT NULL, claimed_at INTEGER NOT NULL, inc TEXT NOT NULL, PRIMARY KEY (name, gen));
CREATE TABLE IF NOT EXISTS monitors (id INTEGER PRIMARY KEY, name TEXT NOT NULL, spec TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS monitor_state (monitor_id INTEGER PRIMARY KEY, state TEXT NOT NULL, version INTEGER NOT NULL, last_run TEXT, changed_at INTEGER);
CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, monitor_id INTEGER NOT NULL, gen INTEGER NOT NULL, owner TEXT NOT NULL, at INTEGER NOT NULL, inc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS results (run_id TEXT PRIMARY KEY, ok INTEGER NOT NULL, latency_ms INTEGER NOT NULL, detail TEXT);
CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY, call_id TEXT NOT NULL UNIQUE, run_id TEXT, payload TEXT NOT NULL, created_at INTEGER NOT NULL, delivered_at INTEGER);
CREATE TABLE IF NOT EXISTS history_export (id INTEGER PRIMARY KEY, run_id TEXT, payload TEXT NOT NULL, created_at INTEGER NOT NULL, exported_at INTEGER);
CREATE TABLE IF NOT EXISTS allocators (name TEXT PRIMARY KEY, next INTEGER NOT NULL, epoch INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS link_positions (link TEXT PRIMARY KEY, position INTEGER NOT NULL, gen INTEGER NOT NULL, last_op TEXT);
CREATE TABLE IF NOT EXISTS cluster_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS health (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE VIEW IF NOT EXISTS must AS SELECT 1 AS ok, '' AS why;
CREATE TRIGGER IF NOT EXISTS must_stale INSTEAD OF INSERT ON must WHEN NOT NEW.ok AND NEW.why = 'stale' BEGIN SELECT RAISE(ABORT, 'stale'); END;
CREATE TRIGGER IF NOT EXISTS must_held INSTEAD OF INSERT ON must WHEN NOT NEW.ok AND NEW.why = 'held' BEGIN SELECT RAISE(ABORT, 'held'); END;
CREATE TRIGGER IF NOT EXISTS must_duplicate INSTEAD OF INSERT ON must WHEN NOT NEW.ok AND NEW.why = 'duplicate' BEGIN SELECT RAISE(ABORT, 'duplicate'); END;
CREATE TRIGGER IF NOT EXISTS must_other INSTEAD OF INSERT ON must WHEN NOT NEW.ok AND NEW.why NOT IN ('stale', 'held', 'duplicate') BEGIN SELECT RAISE(ABORT, 'missing'); END;
`

const incFence = `EXISTS (SELECT 1 FROM cluster_meta WHERE key = 'incarnation' AND value = ?)`

func must(cond, why string, args ...any) Stmt {
	return S(`INSERT INTO must (ok, why) VALUES ((`+cond+`), ?)`, append(args, why)...)
}

func newIncarnation() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

type Store struct {
	rq       *RQ
	node     string
	retries  atomic.Int64 // requests repeated after an unknown outcome
	replayed atomic.Int64 // repeats that found their operation already applied
}

func nowMs() int64 { return time.Now().UnixMilli() }

func (s *Store) Init(ctx context.Context, monitors int) error {
	var stmts []Stmt
	for _, q := range strings.Split(schema, ";\n") {
		if q = strings.TrimSpace(q); q != "" {
			stmts = append(stmts, S(strings.TrimSuffix(q, ";")))
		}
	}
	stmts = append(stmts,
		S(`INSERT OR IGNORE INTO allocators (name, next, epoch) VALUES ('arrival', 1, 1)`),
		S(`INSERT OR IGNORE INTO cluster_meta (key, value) VALUES ('incarnation', ?)`, newIncarnation()),
		S(`INSERT OR IGNORE INTO leases (name, owner, gen, expires_at) VALUES ('scheduler', NULL, 0, 0)`),
		S(`INSERT OR IGNORE INTO leases (name, owner, gen, expires_at) VALUES ('link:peer-a', NULL, 0, 0)`),
		S(`INSERT OR IGNORE INTO link_positions (link, position, gen) VALUES ('peer-a', 0, 0)`),
	)
	stmts = append(stmts, monitorStmts(1, monitors)...)
	_, err := s.rq.Exec(ctx, stmts...)
	return err
}

func monitorStmts(from, to int) []Stmt {
	var out []Stmt
	for i := from; i <= to; i++ {
		spec := fmt.Sprintf(`{"kind":"query","q":"service:checkout-%d level:error","window":"5m","threshold":{"op":">","value":%d},"notify":["webhook:ops"],"labels":{"team":"payments","tier":"1"}}`, i, i%50)
		out = append(out,
			S(`INSERT OR IGNORE INTO monitors (id, name, spec) VALUES (?, ?, ?)`, i, fmt.Sprintf("checkout errors %d", i), spec),
			S(`INSERT OR IGNORE INTO monitor_state (monitor_id, state, version, last_run, changed_at) VALUES (?, 'ok', 0, NULL, 0)`, i))
	}
	return out
}

// Sessions and tokens: the security-sensitive reads are linearizable. A
// member that cannot prove it is reading the latest committed state answers
// unavailable; there is no fallback to a weaker read.

func (s *Store) CreateSession(ctx context.Context, id string, ttlMs int64) error {
	n := nowMs()
	_, err := retry(ctx, s, func(attempt int) (any, error) {
		_, err := s.rq.Exec(ctx, S(`INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`, id, len(id), n, n+ttlMs))
		var se *SQLError
		if attempt > 1 && errors.As(err, &se) && strings.Contains(se.Msg, "UNIQUE") {
			s.replayed.Add(1)
			return nil, nil // the first attempt landed
		}
		return nil, err
	})
	return err
}

func (s *Store) RevokeSession(ctx context.Context, id string) error {
	n := nowMs()
	_, err := retry(ctx, s, func(int) (any, error) {
		res, err := s.rq.Exec(ctx, S(`UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, n, id))
		if err != nil {
			return nil, err
		}
		if res[0].RowsAffected == 0 {
			r, err := s.rq.Query(ctx, Linearizable, S(`SELECT 1 FROM sessions WHERE id = ?`, id))
			if err != nil {
				return nil, err
			}
			if _, ok := One(r); !ok {
				return nil, errNotFound
			}
		}
		return nil, nil
	})
	return err
}

func (s *Store) CheckSession(ctx context.Context, id string) (bool, error) {
	r, err := s.rq.Query(ctx, Linearizable, S(`SELECT 1 FROM sessions WHERE id = ? AND revoked_at IS NULL AND expires_at > ?`, id, nowMs()))
	if err != nil {
		return false, err
	}
	_, ok := One(r)
	return ok, nil
}

func (s *Store) CreateToken(ctx context.Context, id string) error {
	n := nowMs()
	_, err := retry(ctx, s, func(attempt int) (any, error) {
		_, err := s.rq.Exec(ctx, S(`INSERT INTO tokens (id, hash, generation, created_at) VALUES (?, ?, 1, ?)`, id, fmt.Sprintf("sha256:%064x", len(id)), n))
		var se *SQLError
		if attempt > 1 && errors.As(err, &se) && strings.Contains(se.Msg, "UNIQUE") {
			return nil, nil
		}
		return nil, err
	})
	return err
}

// RevokeToken bumps the generation. Repeated after an unknown outcome it
// may bump it twice, which only voids more.
func (s *Store) RevokeToken(ctx context.Context, id string) error {
	n := nowMs()
	_, err := retry(ctx, s, func(int) (any, error) {
		return s.rq.Exec(ctx, S(`UPDATE tokens SET revoked_at = ?, generation = generation + 1 WHERE id = ?`, n, id))
	})
	return err
}

func (s *Store) CheckToken(ctx context.Context, id string) (bool, int64, error) {
	r, err := s.rq.Query(ctx, Linearizable, S(`SELECT generation, revoked_at FROM tokens WHERE id = ?`, id))
	if err != nil {
		return false, 0, err
	}
	rows := Rows(r[0])
	if len(rows) == 0 {
		return false, 0, nil
	}
	gen, _ := rows[0]["generation"].(int64)
	return rows[0]["revoked_at"] == nil, gen, nil
}

// Ownership.

// Claim takes an expired or free lease and moves its generation on by one.
// Repeated after an unknown outcome it may claim twice; the second claim is
// by the same owner with the next generation, which is what it then uses.
func (s *Store) Claim(ctx context.Context, inc, name string, ttlMs int64) (int64, error) {
	n := nowMs()
	return retry(ctx, s, func(int) (int64, error) {
		res, err := s.rq.Exec(ctx,
			must(incFence, "stale", inc),
			S(`UPDATE leases SET owner = ?, gen = gen + 1, expires_at = ? WHERE name = ? AND (owner IS NULL OR expires_at < ?) RETURNING gen`, s.node, n+ttlMs, name, n),
			must(`changes() = 1`, "held"),
			S(`INSERT INTO lease_claims (name, gen, owner, claimed_at, inc) SELECT name, gen, owner, ?, ? FROM leases WHERE name = ?`, n, inc, name),
		)
		if err != nil {
			return 0, err
		}
		g, _ := norm(res[1].Raw[0][0]).(int64)
		return g, nil
	})
}

func (s *Store) Renew(ctx context.Context, inc, name string, gen, ttlMs int64) error {
	n := nowMs()
	_, err := retry(ctx, s, func(int) (any, error) {
		res, err := s.rq.Exec(ctx, S(`UPDATE leases SET expires_at = ? WHERE name = ? AND owner = ? AND gen = ? AND `+incFence, n+ttlMs, name, s.node, gen, inc))
		if err != nil {
			return nil, err
		}
		if res[0].RowsAffected == 0 {
			return nil, errStale
		}
		return nil, nil
	})
	return err
}

// CommitRun is a monitor run as one request: the run (fenced by the
// scheduler generation and the incarnation), its result, the monitor's
// state move, the call intent in the outbox and a pending history export.
// The run id is the operation id: a repeat finds it and answers done.
func (s *Store) CommitRun(ctx context.Context, inc, lease string, gen int64, monitorID int64, runID string, ok bool) error {
	stmts := s.commitRunStmts(inc, lease, gen, monitorID, runID, ok)
	_, err := retry(ctx, s, func(attempt int) (any, error) {
		return nil, s.commitRunAttempt(ctx, attempt, stmts, runID, gen, inc)
	})
	return err
}

func (s *Store) commitRunStmts(inc, lease string, gen int64, monitorID int64, runID string, ok bool) []Stmt {
	n := nowMs()
	okInt, state := 0, "alerting"
	if ok {
		okInt, state = 1, "ok"
	}
	payload := fmt.Sprintf(`{"monitor":%d,"run":"%s","state":"%s","url":"https://toposcope.example/monitors/%d"}`, monitorID, runID, state, monitorID)
	return []Stmt{
		must(`NOT EXISTS (SELECT 1 FROM runs WHERE run_id = ?)`, "duplicate", runID),
		must(`EXISTS (SELECT 1 FROM leases WHERE name = ? AND gen = ? AND owner = ?) AND `+incFence, "stale", lease, gen, s.node, inc),
		S(`INSERT INTO runs (run_id, monitor_id, gen, owner, at, inc) VALUES (?, ?, ?, ?, ?, ?)`, runID, monitorID, gen, s.node, n, inc),
		S(`INSERT INTO results (run_id, ok, latency_ms, detail) VALUES (?, ?, ?, ?)`, runID, okInt, n%900, `{"rows":42,"window":"5m"}`),
		S(`UPDATE monitor_state SET changed_at = CASE WHEN state <> ? THEN ? ELSE changed_at END, state = ?, version = version + 1, last_run = ? WHERE monitor_id = ?`, state, n, state, runID, monitorID),
		must(`changes() = 1`, "missing"), // the monitor
		S(`INSERT INTO outbox (call_id, run_id, payload, created_at) VALUES (?, ?, ?, ?)`, runID+":call", runID, payload, n),
		S(`INSERT INTO history_export (run_id, payload, created_at) VALUES (?, ?, ?)`, runID, payload, n),
	}
}

// commitRunAttempt is one attempt; a repeat (attempt > 1) that finds its
// own run already there is the first attempt having landed.
func (s *Store) commitRunAttempt(ctx context.Context, attempt int, stmts []Stmt, runID string, gen int64, inc string) error {
	{
		_, err := s.rq.Exec(ctx, stmts...)
		if errors.Is(err, errDuplicate) && attempt > 1 {
			// Ours only if it carries our generation and owner.
			r, qerr := s.rq.Query(ctx, Linearizable, S(`SELECT 1 FROM runs WHERE run_id = ? AND gen = ? AND owner = ? AND inc = ?`, runID, gen, s.node, inc))
			if qerr != nil {
				return qerr
			}
			if _, mine := One(r); mine {
				s.replayed.Add(1)
				return nil
			}
		}
		return err
	}
}

// AllocBlock claims [start, start+size) of the arrival counter. Requests
// are applied one at a time in log order, so there is no race to lose. A
// repeat after an unknown outcome may allocate a second block; the first
// is then a gap, never an overlap.
func (s *Store) AllocBlock(ctx context.Context, inc string, size int64) (int64, int64, error) {
	type rng struct{ s, e int64 }
	r, err := retry(ctx, s, func(int) (rng, error) {
		res, err := s.rq.Exec(ctx,
			must(incFence, "stale", inc),
			S(`UPDATE allocators SET next = next + ? WHERE name = 'arrival' RETURNING next`, size),
		)
		if err != nil {
			return rng{}, err
		}
		e, _ := norm(res[1].Raw[0][0]).(int64)
		return rng{e - size, e}, nil
	})
	return r.s, r.e, err
}

// AdvanceLink moves a link-pull position on, only for the current owner.
// The operation id is kept on the row: a repeat that finds it there answers
// the position it set, and does not move it again.
func (s *Store) AdvanceLink(ctx context.Context, inc, lease, link, opID string, gen, by int64) (int64, error) {
	return retry(ctx, s, func(attempt int) (int64, error) {
		res, err := s.rq.Exec(ctx,
			must(`NOT EXISTS (SELECT 1 FROM link_positions WHERE link = ? AND last_op = ?)`, "duplicate", link, opID),
			must(`EXISTS (SELECT 1 FROM leases WHERE name = ? AND gen = ? AND owner = ?) AND `+incFence, "stale", lease, gen, s.node, inc),
			S(`UPDATE link_positions SET position = position + ?, gen = ?, last_op = ? WHERE link = ? RETURNING position`, by, gen, opID, link),
			must(`changes() = 1`, "missing"), // the link
		)
		if errors.Is(err, errDuplicate) {
			r, qerr := s.rq.Query(ctx, Linearizable, S(`SELECT position FROM link_positions WHERE link = ? AND last_op = ?`, link, opID))
			if qerr != nil {
				return 0, qerr
			}
			if v, found := One(r); found {
				if attempt > 1 {
					s.replayed.Add(1)
				}
				p, _ := v.(int64)
				return p, nil
			}
			return 0, err
		}
		if err != nil {
			return 0, err
		}
		p, _ := norm(res[2].Raw[0][0]).(int64)
		return p, nil
	})
}
