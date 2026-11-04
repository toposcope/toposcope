package main

// A deterministic check of the transaction guard. A deferred foreign-key
// violation makes COMMIT fail on demand, and SQLite keeps the transaction
// open after it. The test uses a pool of exactly one connection, so the
// "next request" is guaranteed to get the connection the failed transaction
// ran on unless the guard discarded it.

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

func (s *Server) guardTest(ctx context.Context, st *Store, q map[string]string) (any, error) {
	guard := q["guard"] == "1"
	kind := q["case"]
	for _, stmt := range []string{
		`CREATE TABLE IF NOT EXISTS health (id TEXT PRIMARY KEY, at INTEGER NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS gt_parent (id INTEGER PRIMARY KEY)`,
		`CREATE TABLE IF NOT EXISTS gt_child (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES gt_parent (id) DEFERRABLE INITIALLY DEFERRED)`,
	} {
		if _, err := st.db.ExecContext(ctx, stmt); err != nil {
			return nil, err
		}
	}
	db, err := sql.Open(s.app.Driver(), "control")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	defer db.Close()
	if _, err := db.ExecContext(ctx, `PRAGMA foreign_keys = ON`); err != nil {
		return nil, fmt.Errorf("pragma: %w", err)
	}
	ts := &Store{db: db, node: s.node, guard: guard}
	tag := fmt.Sprintf("gt-%s-%d", s.node, time.Now().UnixNano())
	var txErr error
	switch kind {
	case "commit":
		// COMMIT fails with a deferred constraint and the transaction stays open.
		txErr = ts.tx(ctx, func(tx *sql.Tx) error {
			if _, err := tx.ExecContext(ctx, `INSERT INTO health (id, at) VALUES (?, 0)`, tag+"-in-tx"); err != nil {
				return err
			}
			_, err := tx.ExecContext(ctx, `INSERT INTO gt_child (pid) VALUES (-1)`)
			return err
		})
	case "cancel":
		// The caller's deadline passes between the write and the COMMIT.
		cctx, cancel := context.WithTimeout(ctx, 200*time.Millisecond)
		txErr = ts.tx(cctx, func(tx *sql.Tx) error {
			if _, err := tx.ExecContext(cctx, `INSERT INTO health (id, at) VALUES (?, 0)`, tag+"-in-tx"); err != nil {
				return err
			}
			time.Sleep(400 * time.Millisecond)
			return nil
		})
		cancel()
	default:
		return nil, fmt.Errorf("case must be commit or cancel")
	}
	out := map[string]any{"case": kind, "guard": guard, "tx_error": fmt.Sprint(txErr), "discarded": ts.discarded.Load()}
	// The next request through the same one-connection pool.
	nctx, ncancel := context.WithTimeout(ctx, 3*time.Second)
	_, nerr := db.ExecContext(nctx, `INSERT INTO health (id, at) VALUES (?, 1)`, tag+"-next")
	ncancel()
	out["next_write_error"] = fmt.Sprint(nerr)
	// Is it really committed? Ask through another pool.
	seen := func(id string) bool {
		var one int
		c, cc := context.WithTimeout(ctx, 3*time.Second)
		defer cc()
		return st.db.QueryRowContext(c, `SELECT 1 FROM health WHERE id = ?`, id).Scan(&one) == nil
	}
	out["next_write_visible_elsewhere"] = seen(tag + "-next")
	out["failed_tx_row_visible"] = seen(tag + "-in-tx")
	// Does another writer get the write lock?
	octx, ocancel := context.WithTimeout(ctx, 3*time.Second)
	_, oerr := st.db.ExecContext(octx, `INSERT INTO health (id, at) VALUES (?, 2)`, tag+"-other")
	ocancel()
	out["other_writer_error"] = fmt.Sprint(oerr)
	// Closing the pool closes its connection and releases anything it held.
	db.Close()
	out["next_write_visible_after_pool_closed"] = seen(tag + "-next")
	c2, cc2 := context.WithTimeout(ctx, 6*time.Second)
	_, aerr := st.db.ExecContext(c2, `INSERT INTO health (id, at) VALUES (?, 3)`, tag+"-after")
	cc2()
	out["other_writer_error_after_pool_closed"] = fmt.Sprint(aerr)
	return out, nil
}
