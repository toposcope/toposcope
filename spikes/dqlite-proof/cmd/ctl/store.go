package main

// The Toposcope-shaped operations. Each one that changes several rows is one
// short transaction; every write from an owner carries its generation and is
// refused when that generation is no longer current.

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const schema = `
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE TABLE IF NOT EXISTS tokens (id TEXT PRIMARY KEY, hash TEXT NOT NULL, generation INTEGER NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE TABLE IF NOT EXISTS leases (name TEXT PRIMARY KEY, owner TEXT, gen INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS lease_claims (name TEXT NOT NULL, gen INTEGER NOT NULL, owner TEXT NOT NULL, claimed_at INTEGER NOT NULL, PRIMARY KEY (name, gen));
CREATE TABLE IF NOT EXISTS monitors (id INTEGER PRIMARY KEY, name TEXT NOT NULL, spec TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS monitor_state (monitor_id INTEGER PRIMARY KEY, state TEXT NOT NULL, version INTEGER NOT NULL, last_run TEXT, changed_at INTEGER);
CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, monitor_id INTEGER NOT NULL, gen INTEGER NOT NULL, owner TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS results (run_id TEXT PRIMARY KEY, ok INTEGER NOT NULL, latency_ms INTEGER NOT NULL, detail TEXT);
CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY, call_id TEXT NOT NULL UNIQUE, run_id TEXT, payload TEXT NOT NULL, created_at INTEGER NOT NULL, delivered_at INTEGER);
CREATE TABLE IF NOT EXISTS history_export (id INTEGER PRIMARY KEY, run_id TEXT, payload TEXT NOT NULL, created_at INTEGER NOT NULL, exported_at INTEGER);
CREATE TABLE IF NOT EXISTS allocators (name TEXT PRIMARY KEY, next INTEGER NOT NULL, epoch INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS link_positions (link TEXT PRIMARY KEY, position INTEGER NOT NULL, gen INTEGER NOT NULL);
`

var (
	errStale    = errors.New("stale generation refused")
	errHeld     = errors.New("lease held by another owner")
	errNotFound = errors.New("not found")
)

type Store struct {
	db        *sql.DB
	node      string
	discarded atomic.Int64
	txErrs    sync.Map
}

func nowMs() int64 { return time.Now().UnixMilli() }

// tx runs fn in one transaction on a connection of its own. A COMMIT or
// ROLLBACK that fails can leave the transaction open on the leader (SQLite
// keeps it open after a busy COMMIT, and go-dqlite only marks network and
// leadership errors as a bad connection), so that connection is closed
// rather than returned to the pool: reused, it would acknowledge writes that
// never commit and hold the write lock against every other member. The
// guard can be switched off (TX_GUARD=0) to reproduce that.
func (s *Store) tx(ctx context.Context, fn func(*sql.Tx) error) error {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		if rerr := tx.Rollback(); rerr != nil {
			s.discard(conn, "rollback: "+rerr.Error())
		}
		return err
	}
	if err := tx.Commit(); err != nil {
		s.discard(conn, "commit: "+err.Error())
		return err
	}
	return nil
}

var txGuard = os.Getenv("TX_GUARD") != "0"

func (s *Store) discard(conn *sql.Conn, why string) {
	if len(why) > 80 {
		why = why[:80]
	}
	s.txErrs.Store(why, true)
	s.discarded.Add(1)
	log.Printf("tx guard: closing connection after failed %s (guard on: %v)", why, txGuard)
	if txGuard {
		_ = conn.Raw(func(any) error { return driver.ErrBadConn })
	}
}

func (s *Store) Init(ctx context.Context, monitors int) error {
	for _, stmt := range strings.Split(schema, ";") {
		if strings.TrimSpace(stmt) == "" {
			continue
		}
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("%s: %w", stmt, err)
		}
	}
	return s.tx(ctx, func(tx *sql.Tx) error {
		for _, q := range []string{
			`INSERT OR IGNORE INTO allocators (name, next, epoch) VALUES ('arrival', 1, 1)`,
			`INSERT OR IGNORE INTO leases (name, owner, gen, expires_at) VALUES ('scheduler', NULL, 0, 0)`,
			`INSERT OR IGNORE INTO leases (name, owner, gen, expires_at) VALUES ('link:peer-a', NULL, 0, 0)`,
			`INSERT OR IGNORE INTO link_positions (link, position, gen) VALUES ('peer-a', 0, 0)`,
		} {
			if _, err := tx.ExecContext(ctx, q); err != nil {
				return err
			}
		}
		return seedMonitors(ctx, tx, 1, monitors)
	})
}

func seedMonitors(ctx context.Context, tx *sql.Tx, from, to int) error {
	for i := from; i <= to; i++ {
		spec := fmt.Sprintf(`{"kind":"query","q":"service:checkout-%d level:error","window":"5m","threshold":{"op":">","value":%d},"notify":["webhook:ops"],"labels":{"team":"payments","tier":"1"}}`, i, i%50)
		if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO monitors (id, name, spec) VALUES (?, ?, ?)`, i, fmt.Sprintf("checkout errors %d", i), spec); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO monitor_state (monitor_id, state, version, last_run, changed_at) VALUES (?, 'ok', 0, NULL, 0)`, i); err != nil {
			return err
		}
	}
	return nil
}

// Sessions and tokens: the security-sensitive reads.

func (s *Store) CreateSession(ctx context.Context, id string, ttlMs int64) error {
	n := nowMs()
	_, err := s.db.ExecContext(ctx, `INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`, id, len(id), n, n+ttlMs)
	return err
}

func (s *Store) RevokeSession(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, nowMs(), id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		var one int
		if err := s.db.QueryRowContext(ctx, `SELECT 1 FROM sessions WHERE id = ?`, id).Scan(&one); err != nil {
			return errNotFound
		}
	}
	return nil
}

func (s *Store) CheckSession(ctx context.Context, id string) (bool, error) {
	var one int
	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM sessions WHERE id = ? AND revoked_at IS NULL AND expires_at > ?`, id, nowMs()).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func (s *Store) CreateToken(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO tokens (id, hash, generation, created_at) VALUES (?, ?, 1, ?)`, id, fmt.Sprintf("sha256:%064x", len(id)), nowMs())
	return err
}

// RevokeToken bumps the generation, which is what a cache keyed on
// (token, generation) is voided by.
func (s *Store) RevokeToken(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE tokens SET revoked_at = ?, generation = generation + 1 WHERE id = ?`, nowMs(), id)
	return err
}

func (s *Store) CheckToken(ctx context.Context, id string) (bool, int64, error) {
	var gen int64
	var revoked sql.NullInt64
	err := s.db.QueryRowContext(ctx, `SELECT generation, revoked_at FROM tokens WHERE id = ?`, id).Scan(&gen, &revoked)
	if errors.Is(err, sql.ErrNoRows) {
		return false, 0, nil
	}
	if err != nil {
		return false, 0, err
	}
	return !revoked.Valid, gen, nil
}

// Ownership: a durable record with a generation.

// Claim takes an expired or free lease and moves its generation on by one.
func (s *Store) Claim(ctx context.Context, name string, ttlMs int64) (int64, error) {
	var gen int64
	err := s.tx(ctx, func(tx *sql.Tx) error {
		n := nowMs()
		res, err := tx.ExecContext(ctx, `UPDATE leases SET owner = ?, gen = gen + 1, expires_at = ? WHERE name = ? AND (owner IS NULL OR expires_at < ?)`, s.node, n+ttlMs, name, n)
		if err != nil {
			return err
		}
		if k, _ := res.RowsAffected(); k == 0 {
			return errHeld
		}
		if err := tx.QueryRowContext(ctx, `SELECT gen FROM leases WHERE name = ?`, name).Scan(&gen); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO lease_claims (name, gen, owner, claimed_at) VALUES (?, ?, ?, ?)`, name, gen, s.node, n)
		return err
	})
	return gen, err
}

func (s *Store) Renew(ctx context.Context, name string, gen, ttlMs int64) error {
	res, err := s.db.ExecContext(ctx, `UPDATE leases SET expires_at = ? WHERE name = ? AND owner = ? AND gen = ?`, nowMs()+ttlMs, name, s.node, gen)
	if err != nil {
		return err
	}
	if k, _ := res.RowsAffected(); k == 0 {
		return errStale
	}
	return nil
}

// CommitRun is a monitor run as one transaction: the run (fenced by the
// scheduler generation), its result, the monitor's state move, the call
// intent in the outbox and a pending history export row.
func (s *Store) CommitRun(ctx context.Context, lease string, gen int64, monitorID int64, runID string, ok bool) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		n := nowMs()
		res, err := tx.ExecContext(ctx, `INSERT INTO runs (run_id, monitor_id, gen, owner, at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM leases WHERE name = ? AND gen = ? AND owner = ?)`,
			runID, monitorID, gen, s.node, n, lease, gen, s.node)
		if err != nil {
			return err
		}
		if k, _ := res.RowsAffected(); k == 0 {
			return errStale
		}
		okInt, state := 0, "alerting"
		if ok {
			okInt, state = 1, "ok"
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO results (run_id, ok, latency_ms, detail) VALUES (?, ?, ?, ?)`, runID, okInt, n%900, `{"rows":42,"window":"5m"}`); err != nil {
			return err
		}
		res, err = tx.ExecContext(ctx, `UPDATE monitor_state SET changed_at = CASE WHEN state <> ? THEN ? ELSE changed_at END, state = ?, version = version + 1, last_run = ? WHERE monitor_id = ?`, state, n, state, runID, monitorID)
		if err != nil {
			return err
		}
		if k, _ := res.RowsAffected(); k == 0 {
			return fmt.Errorf("monitor %d missing", monitorID)
		}
		payload := fmt.Sprintf(`{"monitor":%d,"run":"%s","state":"%s","url":"https://toposcope.example/monitors/%d"}`, monitorID, runID, state, monitorID)
		if _, err := tx.ExecContext(ctx, `INSERT INTO outbox (call_id, run_id, payload, created_at) VALUES (?, ?, ?, ?)`, runID+":call", runID, payload, n); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO history_export (run_id, payload, created_at) VALUES (?, ?, ?)`, runID, payload, n)
		return err
	})
}

// AllocBlock claims [start, start+size) of the arrival counter by a
// conditional write on the value read; a lost race is retried.
func (s *Store) AllocBlock(ctx context.Context, size int64) (int64, int64, error) {
	for attempt := 0; attempt < 20; attempt++ {
		var start int64
		err := s.tx(ctx, func(tx *sql.Tx) error {
			if err := tx.QueryRowContext(ctx, `SELECT next FROM allocators WHERE name = 'arrival'`).Scan(&start); err != nil {
				return err
			}
			res, err := tx.ExecContext(ctx, `UPDATE allocators SET next = ? WHERE name = 'arrival' AND next = ?`, start+size, start)
			if err != nil {
				return err
			}
			if k, _ := res.RowsAffected(); k == 0 {
				return errHeld
			}
			return nil
		})
		if errors.Is(err, errHeld) {
			continue
		}
		if err != nil {
			return 0, 0, err
		}
		return start, start + size, nil
	}
	return 0, 0, errors.New("allocator: too many lost races")
}

// AdvanceLink moves a link-pull position on, only for the current owner.
func (s *Store) AdvanceLink(ctx context.Context, lease, link string, gen, by int64) (int64, error) {
	var pos int64
	err := s.tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `UPDATE link_positions SET position = position + ?, gen = ? WHERE link = ? AND EXISTS (SELECT 1 FROM leases WHERE name = ? AND gen = ? AND owner = ?)`, by, gen, link, lease, gen, s.node)
		if err != nil {
			return err
		}
		if k, _ := res.RowsAffected(); k == 0 {
			return errStale
		}
		return tx.QueryRowContext(ctx, `SELECT position FROM link_positions WHERE link = ?`, link).Scan(&pos)
	})
	return pos, err
}
