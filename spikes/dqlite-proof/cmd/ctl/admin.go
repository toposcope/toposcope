package main

// Measurement and maintenance endpoints: latency benchmarks, seeding to a
// realistic control-plane size, outbox/history churn, memory, checksums,
// backup and restore.

import (
	"bufio"
	"context"
	"database/sql"
	"fmt"
	"hash/fnv"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

var tables = []string{"cluster_meta", "sessions", "tokens", "leases", "lease_claims", "monitors", "monitor_state", "runs", "results", "outbox", "history_export", "allocators", "link_positions"}

func pct(d []time.Duration) map[string]any {
	if len(d) == 0 {
		return map[string]any{"n": 0}
	}
	sort.Slice(d, func(i, j int) bool { return d[i] < d[j] })
	p := func(q float64) int64 {
		i := int(q * float64(len(d)))
		if i >= len(d) {
			i = len(d) - 1
		}
		return d[i].Microseconds()
	}
	var sum time.Duration
	for _, x := range d {
		sum += x
	}
	return map[string]any{"n": len(d), "p50_us": p(0.5), "p95_us": p(0.95), "p99_us": p(0.99), "max_us": d[len(d)-1].Microseconds(), "mean_us": (sum / time.Duration(len(d))).Microseconds()}
}

func (s *Server) bench(_ context.Context, st *Store, q map[string]string) (any, error) {
	op := q["op"]
	n := int(atoi(q["n"], 1000))
	conc := int(atoi(q["conc"], 1))
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	run := time.Now().UnixNano()
	var gen int64
	setupLease := func(name string) error {
		if _, err := st.db.ExecContext(ctx, `INSERT OR IGNORE INTO leases (name, owner, gen, expires_at) VALUES (?, NULL, 0, 0)`, name); err != nil {
			return err
		}
		if _, err := st.db.ExecContext(ctx, `UPDATE leases SET owner = NULL WHERE name = ?`, name); err != nil {
			return err
		}
		g, err := st.Claim(ctx, s.localInc(), name, 3600_000)
		gen = g
		return err
	}
	var err error
	switch op {
	case "session_check":
		err = st.tx(ctx, func(tx *sql.Tx) error {
			for i := 0; i < 1000; i++ {
				if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)`, fmt.Sprintf("b-%d", i), nowMs(), nowMs()+86400_000); err != nil {
					return err
				}
			}
			return nil
		})
	case "token_check":
		err = st.tx(ctx, func(tx *sql.Tx) error {
			for i := 0; i < 100; i++ {
				if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO tokens (id, hash, generation, created_at) VALUES (?, 'h', 1, ?)`, fmt.Sprintf("bt-%d", i), nowMs()); err != nil {
					return err
				}
			}
			return nil
		})
	case "session_revoke":
		err = st.tx(ctx, func(tx *sql.Tx) error {
			for i := 0; i < n; i++ {
				if _, err := tx.ExecContext(ctx, `INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)`, fmt.Sprintf("br-%s-%d-%d", s.node, run, i), nowMs(), nowMs()+86400_000); err != nil {
					return err
				}
			}
			return nil
		})
	case "lease_claim":
		_, err = st.db.ExecContext(ctx, `INSERT OR IGNORE INTO leases (name, owner, gen, expires_at) VALUES (?, NULL, 0, 0)`, "bench:claim:"+s.node)
	case "lease_renew":
		err = setupLease("bench:renew:" + s.node)
	case "run_commit":
		err = setupLease("bench:sched:" + s.node)
	case "link_advance":
		if _, err = st.db.ExecContext(ctx, `INSERT OR IGNORE INTO link_positions (link, position, gen) VALUES (?, 0, 0)`, "bench:"+s.node); err == nil {
			err = setupLease("bench:link:" + s.node)
		}
	case "session_create", "block_alloc":
	default:
		return nil, fmt.Errorf("unknown op %q", op)
	}
	if err != nil {
		return nil, fmt.Errorf("setup: %w", err)
	}
	do := func(i int) error {
		switch op {
		case "session_create":
			return st.CreateSession(ctx, fmt.Sprintf("bc-%s-%d-%d", s.node, run, i), 3600_000)
		case "session_check":
			_, err := st.CheckSession(ctx, fmt.Sprintf("b-%d", i%1000))
			return err
		case "session_revoke":
			return st.RevokeSession(ctx, fmt.Sprintf("br-%s-%d-%d", s.node, run, i))
		case "token_check":
			_, _, err := st.CheckToken(ctx, fmt.Sprintf("bt-%d", i%100))
			return err
		case "lease_claim":
			_, err := st.Claim(ctx, s.localInc(), "bench:claim:"+s.node, -10)
			return err
		case "lease_renew":
			return st.Renew(ctx, s.localInc(), "bench:renew:"+s.node, gen, 3600_000)
		case "run_commit":
			return st.CommitRun(ctx, s.localInc(), "bench:sched:"+s.node, gen, int64(i%100+1), fmt.Sprintf("bench-%s-%d-%d", s.node, run, i), i%7 != 0)
		case "block_alloc":
			_, _, err := st.AllocBlock(ctx, s.localInc(), 1000)
			return err
		case "link_advance":
			_, err := st.AdvanceLink(ctx, s.localInc(), "bench:link:"+s.node, "bench:"+s.node, gen, 1)
			return err
		}
		return nil
	}
	durs := make([]time.Duration, n)
	var errs int64
	var firstErr string
	var mu sync.Mutex
	var wg sync.WaitGroup
	next := make(chan int, n)
	for i := 0; i < n; i++ {
		next <- i
	}
	close(next)
	start := time.Now()
	for c := 0; c < conc; c++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range next {
				t := time.Now()
				if err := do(i); err != nil {
					mu.Lock()
					errs++
					if firstErr == "" {
						firstErr = err.Error()
					}
					mu.Unlock()
				}
				durs[i] = time.Since(t)
			}
		}()
	}
	wg.Wait()
	wall := time.Since(start)
	out := pct(durs)
	out["op"], out["conc"], out["errors"], out["first_error"] = op, conc, errs, firstErr
	out["ops_per_s"] = int(float64(n) / wall.Seconds())
	return out, nil
}

func (s *Server) seed(ctx context.Context, st *Store, q map[string]string) (any, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	sessions, monitors, tokens := int(atoi(q["sessions"], 0)), int(atoi(q["monitors"], 0)), int(atoi(q["tokens"], 0))
	t := time.Now()
	for from := 0; from < sessions; from += 1000 {
		err := st.tx(ctx, func(tx *sql.Tx) error {
			for i := from; i < from+1000 && i < sessions; i++ {
				n := nowMs()
				if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`, fmt.Sprintf("m-%07d", i), i%500, n, n+30*86400_000); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	for from := 1; from <= monitors; from += 1000 {
		to := from + 999
		if to > monitors {
			to = monitors
		}
		if err := st.tx(ctx, func(tx *sql.Tx) error { return seedMonitors(ctx, tx, from, to) }); err != nil {
			return nil, err
		}
	}
	for from := 0; from < tokens; from += 1000 {
		err := st.tx(ctx, func(tx *sql.Tx) error {
			for i := from; i < from+1000 && i < tokens; i++ {
				if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO tokens (id, hash, generation, created_at) VALUES (?, ?, 1, ?)`, fmt.Sprintf("tk-%06d", i), fmt.Sprintf("sha256:%064x", i), nowMs()); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	return map[string]any{"ms": time.Since(t).Milliseconds()}, nil
}

// churn writes n outbox rows and n pending history-export rows in one
// transaction, the shape of a burst of monitor runs.
func (s *Server) churn(ctx context.Context, st *Store, q map[string]string) (any, error) {
	n := int(atoi(q["n"], 1000))
	batch := atoi(q["batch"], 0)
	err := st.tx(ctx, func(tx *sql.Tx) error {
		now := nowMs()
		for i := 0; i < n; i++ {
			id := fmt.Sprintf("churn-%d-%d", batch, i)
			payload := fmt.Sprintf(`{"monitor":%d,"run":"%s","state":"alerting","url":"https://toposcope.example/monitors/%d","summary":"error rate 4.2%% over 5m on checkout-api (threshold 2%%)","labels":{"team":"payments","env":"prod","region":"eu-west-1"},"attempt":1}`, i%10000+1, id, i%10000+1)
			if _, err := tx.ExecContext(ctx, `INSERT INTO outbox (call_id, run_id, payload, created_at) VALUES (?, ?, ?, ?)`, id+":call", id, payload, now); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO history_export (run_id, payload, created_at) VALUES (?, ?, ?)`, id, payload[:200], now); err != nil {
				return err
			}
		}
		return nil
	})
	return nil, err
}

// expire is the cleanup job: delivered calls and exported history older
// than the newest `keep` rows go.
func (s *Server) expire(ctx context.Context, st *Store, q map[string]string) (any, error) {
	keep := atoi(q["keep"], 20000)
	var deleted int64
	err := st.tx(ctx, func(tx *sql.Tx) error {
		for _, t := range []string{"outbox", "history_export"} {
			res, err := tx.ExecContext(ctx, fmt.Sprintf(`DELETE FROM %s WHERE id <= (SELECT coalesce(max(id), 0) FROM %s) - ?`, t, t), keep)
			if err != nil {
				return err
			}
			k, _ := res.RowsAffected()
			deleted += k
		}
		return nil
	})
	return map[string]any{"deleted": deleted}, err
}

// expireChunk is a cleanup job of the kind the service would run: keep the
// newest `keep` rows of each growing table, deleting the rest in chunks of
// `chunk` rows, one short transaction each.
func (s *Server) expireChunk(_ context.Context, st *Store, q map[string]string) (any, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	keep, chunk := atoi(q["keep"], 20000), atoi(q["chunk"], 500)
	deleted := map[string]int64{}
	txs := 0
	for _, t := range []string{"outbox", "history_export", "results", "runs"} {
		for {
			var n int64
			if err := st.db.QueryRowContext(ctx, "SELECT count(*) FROM "+t).Scan(&n); err != nil {
				return nil, err
			}
			if n <= keep {
				break
			}
			k := n - keep
			if k > chunk {
				k = chunk
			}
			res, err := st.db.ExecContext(ctx, fmt.Sprintf("DELETE FROM %s WHERE rowid IN (SELECT rowid FROM %s ORDER BY rowid LIMIT ?)", t, t), k)
			if err != nil {
				return nil, err
			}
			d, _ := res.RowsAffected()
			deleted[t] += d
			txs++
		}
	}
	return map[string]any{"deleted": deleted, "transactions": txs}, nil
}

func procMem() (rss, hwm int64) {
	f, err := os.Open("/proc/self/status")
	if err != nil {
		return 0, 0
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var v int64
		if strings.HasPrefix(sc.Text(), "VmRSS:") {
			fmt.Sscanf(strings.TrimPrefix(sc.Text(), "VmRSS:"), "%d", &v)
			rss = v
		}
		if strings.HasPrefix(sc.Text(), "VmHWM:") {
			fmt.Sscanf(strings.TrimPrefix(sc.Text(), "VmHWM:"), "%d", &v)
			hwm = v
		}
	}
	return
}

func dirSize(dir string) int64 {
	var n int64
	_ = filepath.Walk(dir, func(_ string, fi os.FileInfo, err error) error {
		if err == nil && !fi.IsDir() {
			n += fi.Size()
		}
		return nil
	})
	return n
}

func (s *Server) mem(ctx context.Context, st *Store, q map[string]string) (any, error) {
	rss, hwm := procMem()
	out := map[string]any{"rss_kb": rss, "hwm_kb": hwm, "data_dir_kb": dirSize(s.dataDir) / 1024}
	for _, p := range []string{"page_count", "freelist_count", "page_size"} {
		var v int64
		if err := st.db.QueryRowContext(ctx, "PRAGMA "+p).Scan(&v); err == nil {
			out[p] = v
		} else {
			out[p+"_error"] = err.Error()
		}
	}
	if q["counts"] == "1" {
		counts := map[string]int64{}
		for _, t := range tables {
			var c int64
			_ = st.db.QueryRowContext(ctx, "SELECT count(*) FROM "+t).Scan(&c)
			counts[t] = c
		}
		out["counts"] = counts
	}
	return out, nil
}

// checksums sums a hash of every row, so it does not depend on row order.
func checksums(ctx context.Context, db *sql.DB) (map[string]map[string]any, error) {
	out := map[string]map[string]any{}
	for _, t := range tables {
		rows, err := db.QueryContext(ctx, "SELECT * FROM "+t)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", t, err)
		}
		cols, _ := rows.Columns()
		var count int64
		var sum uint64
		for rows.Next() {
			vals := make([]any, len(cols))
			ptrs := make([]any, len(cols))
			for i := range vals {
				ptrs[i] = &vals[i]
			}
			if err := rows.Scan(ptrs...); err != nil {
				rows.Close()
				return nil, err
			}
			h := fnv.New64a()
			for _, v := range vals {
				if b, ok := v.([]byte); ok {
					v = string(b)
				}
				fmt.Fprintf(h, "%v\x1f", v)
			}
			sum += h.Sum64()
			count++
		}
		rows.Close()
		out[t] = map[string]any{"rows": count, "sum": fmt.Sprintf("%016x", sum)}
	}
	return out, nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

// openDump opens a private copy of a dqlite dump with plain SQLite.
func openDump(dir string) (*sql.DB, error) {
	tmp, err := os.MkdirTemp("", "dump")
	if err != nil {
		return nil, err
	}
	if err := copyFile(filepath.Join(dir, "control"), filepath.Join(tmp, "control.db")); err != nil {
		return nil, err
	}
	if _, err := os.Stat(filepath.Join(dir, "control-wal")); err == nil {
		if err := copyFile(filepath.Join(dir, "control-wal"), filepath.Join(tmp, "control.db-wal")); err != nil {
			return nil, err
		}
	}
	return sql.Open("sqlite3", filepath.Join(tmp, "control.db"))
}

// backup takes dqlite's dump from the leader: the database file and its WAL.
func (s *Server) backup(ctx context.Context, st *Store, q map[string]string) (any, error) {
	dir := q["dir"]
	if dir == "" {
		dir = "/out/backup"
	}
	t := time.Now()
	cli, err := s.app.Leader(ctx)
	if err != nil {
		return nil, err
	}
	defer cli.Close()
	files, err := cli.Dump(ctx, "control")
	if err != nil {
		return nil, err
	}
	dumpMs := time.Since(t).Milliseconds()
	_ = os.MkdirAll(dir, 0o755)
	sizes := map[string]int{}
	for _, f := range files {
		if err := os.WriteFile(filepath.Join(dir, f.Name), f.Data, 0o644); err != nil {
			return nil, err
		}
		sizes[f.Name] = len(f.Data)
	}
	db, err := openDump(dir)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	sums, err := checksums(ctx, db)
	if err != nil {
		return nil, err
	}
	var next int64
	_ = db.QueryRowContext(ctx, `SELECT next FROM allocators WHERE name = 'arrival'`).Scan(&next)
	return map[string]any{"dump_ms": dumpMs, "files": sizes, "checksums": sums, "allocator_next": next}, nil
}

// restore replays a dump into this (fresh) cluster table by table, then
// fences what a restore cannot know: positions and generations handed out
// after the backup was taken.
func (s *Server) restore(_ context.Context, st *Store, q map[string]string) (any, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	dir := q["dir"]
	if dir == "" {
		dir = "/out/backup"
	}
	t := time.Now()
	src, err := openDump(dir)
	if err != nil {
		return nil, err
	}
	defer src.Close()
	rows, err := src.QueryContext(ctx, `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'health' ORDER BY rowid`)
	if err != nil {
		return nil, err
	}
	type tbl struct{ name, sql string }
	var tbls []tbl
	for rows.Next() {
		var x tbl
		if err := rows.Scan(&x.name, &x.sql); err != nil {
			return nil, err
		}
		tbls = append(tbls, x)
	}
	rows.Close()
	copied := map[string]int{}
	for _, x := range tbls {
		if _, err := st.db.ExecContext(ctx, x.sql); err != nil {
			return nil, fmt.Errorf("create %s: %w", x.name, err)
		}
		if x.name == "cluster_meta" {
			// Written last, with a new incarnation: members adopt the
			// first incarnation they see, so the old one must never show.
			continue
		}
		r, err := src.QueryContext(ctx, "SELECT * FROM "+x.name)
		if err != nil {
			return nil, err
		}
		cols, _ := r.Columns()
		ins := fmt.Sprintf("INSERT INTO %s VALUES (%s)", x.name, strings.TrimSuffix(strings.Repeat("?,", len(cols)), ","))
		var batch [][]any
		flush := func() error {
			if len(batch) == 0 {
				return nil
			}
			err := st.tx(ctx, func(tx *sql.Tx) error {
				for _, b := range batch {
					if _, err := tx.ExecContext(ctx, ins, b...); err != nil {
						return err
					}
				}
				return nil
			})
			copied[x.name] += len(batch)
			batch = batch[:0]
			return err
		}
		for r.Next() {
			vals := make([]any, len(cols))
			ptrs := make([]any, len(cols))
			for i := range vals {
				ptrs[i] = &vals[i]
			}
			if err := r.Scan(ptrs...); err != nil {
				r.Close()
				return nil, err
			}
			batch = append(batch, vals)
			if len(batch) == 500 {
				if err := flush(); err != nil {
					r.Close()
					return nil, err
				}
			}
		}
		r.Close()
		if err := flush(); err != nil {
			return nil, err
		}
	}
	replayMs := time.Since(t).Milliseconds()
	sums, err := checksums(ctx, st.db)
	if err != nil {
		return nil, err
	}
	// What a restore cannot know is what the lost installation handed out
	// after the dump. A fresh incarnation puts everything handed out from
	// here on in a new namespace (positions, generations and run ids carry
	// it), and nothing that still holds the old one can write.
	from, inc := "", newIncarnation()
	_ = src.QueryRowContext(ctx, `SELECT value FROM cluster_meta WHERE key = 'incarnation'`).Scan(&from)
	err = st.tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `UPDATE leases SET owner = NULL, expires_at = 0`); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO cluster_meta (key, value) VALUES ('incarnation', ?)`, inc)
		return err
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"replay_ms": replayMs, "rows": copied, "checksums": sums, "from_incarnation": from, "incarnation": inc}, nil
}
