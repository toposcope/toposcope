package main

// Measurement and maintenance endpoints, as in cmd/ctl, on rqlite.

import (
	"bytes"
	"context"
	"database/sql"
	"fmt"
	"hash/fnv"
	"io"
	"net/http"
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
		if _, err := st.rq.Exec(ctx,
			S(`INSERT OR IGNORE INTO leases (name, owner, gen, expires_at) VALUES (?, NULL, 0, 0)`, name),
			S(`UPDATE leases SET owner = NULL WHERE name = ?`, name)); err != nil {
			return err
		}
		g, err := st.Claim(ctx, s.localInc(), name, 3600_000)
		gen = g
		return err
	}
	var err error
	switch op {
	case "session_check":
		var stmts []Stmt
		for i := 0; i < 1000; i++ {
			stmts = append(stmts, S(`INSERT OR IGNORE INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)`, fmt.Sprintf("b-%d", i), nowMs(), nowMs()+86400_000))
		}
		_, err = st.rq.Exec(ctx, stmts...)
	case "token_check":
		var stmts []Stmt
		for i := 0; i < 100; i++ {
			stmts = append(stmts, S(`INSERT OR IGNORE INTO tokens (id, hash, generation, created_at) VALUES (?, 'h', 1, ?)`, fmt.Sprintf("bt-%d", i), nowMs()))
		}
		_, err = st.rq.Exec(ctx, stmts...)
	case "session_revoke":
		for from := 0; from < n && err == nil; from += 1000 {
			var stmts []Stmt
			for i := from; i < from+1000 && i < n; i++ {
				stmts = append(stmts, S(`INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)`, fmt.Sprintf("br-%s-%d-%d", s.node, run, i), nowMs(), nowMs()+86400_000))
			}
			_, err = st.rq.Exec(ctx, stmts...)
		}
	case "lease_claim":
		_, err = st.rq.Exec(ctx, S(`INSERT OR IGNORE INTO leases (name, owner, gen, expires_at) VALUES (?, NULL, 0, 0)`, "bench:claim:"+s.node))
	case "lease_renew":
		err = setupLease("bench:renew:" + s.node)
	case "run_commit":
		err = setupLease("bench:sched:" + s.node)
	case "link_advance":
		if _, err = st.rq.Exec(ctx, S(`INSERT OR IGNORE INTO link_positions (link, position, gen) VALUES (?, 0, 0)`, "bench:"+s.node)); err == nil {
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
		octx, ocancel := context.WithTimeout(ctx, 10*time.Second)
		defer ocancel()
		switch op {
		case "session_create":
			return st.CreateSession(octx, fmt.Sprintf("bc-%s-%d-%d", s.node, run, i), 3600_000)
		case "session_check":
			_, err := st.CheckSession(octx, fmt.Sprintf("b-%d", i%1000))
			return err
		case "session_revoke":
			return st.RevokeSession(octx, fmt.Sprintf("br-%s-%d-%d", s.node, run, i))
		case "token_check":
			_, _, err := st.CheckToken(octx, fmt.Sprintf("bt-%d", i%100))
			return err
		case "lease_claim":
			_, err := st.Claim(octx, s.localInc(), "bench:claim:"+s.node, -10)
			return err
		case "lease_renew":
			return st.Renew(octx, s.localInc(), "bench:renew:"+s.node, gen, 3600_000)
		case "run_commit":
			return st.CommitRun(octx, s.localInc(), "bench:sched:"+s.node, gen, int64(i%100+1), fmt.Sprintf("bench-%s-%d-%d", s.node, run, i), i%7 != 0)
		case "block_alloc":
			_, _, err := st.AllocBlock(octx, s.localInc(), 1000)
			return err
		case "link_advance":
			_, err := st.AdvanceLink(octx, s.localInc(), "bench:link:"+s.node, "bench:"+s.node, fmt.Sprintf("bl-%d-%d", run, i), gen, 1)
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

func (s *Server) seed(_ context.Context, st *Store, q map[string]string) (any, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	sessions, monitors, tokens := int(atoi(q["sessions"], 0)), int(atoi(q["monitors"], 0)), int(atoi(q["tokens"], 0))
	t := time.Now()
	for from := 0; from < sessions; from += 1000 {
		var stmts []Stmt
		for i := from; i < from+1000 && i < sessions; i++ {
			n := nowMs()
			stmts = append(stmts, S(`INSERT OR IGNORE INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`, fmt.Sprintf("m-%07d", i), i%500, n, n+30*86400_000))
		}
		if _, err := st.rq.Exec(ctx, stmts...); err != nil {
			return nil, err
		}
	}
	for from := 1; from <= monitors; from += 500 {
		to := min(from+499, monitors)
		if _, err := st.rq.Exec(ctx, monitorStmts(from, to)...); err != nil {
			return nil, err
		}
	}
	for from := 0; from < tokens; from += 1000 {
		var stmts []Stmt
		for i := from; i < from+1000 && i < tokens; i++ {
			stmts = append(stmts, S(`INSERT OR IGNORE INTO tokens (id, hash, generation, created_at) VALUES (?, ?, 1, ?)`, fmt.Sprintf("tk-%06d", i), fmt.Sprintf("sha256:%064x", i), nowMs()))
		}
		if _, err := st.rq.Exec(ctx, stmts...); err != nil {
			return nil, err
		}
	}
	return map[string]any{"ms": time.Since(t).Milliseconds()}, nil
}

func (s *Server) churn(ctx context.Context, st *Store, q map[string]string) (any, error) {
	n := int(atoi(q["n"], 1000))
	batch := atoi(q["batch"], 0)
	now := nowMs()
	var stmts []Stmt
	for i := 0; i < n; i++ {
		id := fmt.Sprintf("churn-%d-%d", batch, i)
		payload := fmt.Sprintf(`{"monitor":%d,"run":"%s","state":"alerting","url":"https://toposcope.example/monitors/%d","summary":"error rate 4.2%% over 5m on checkout-api (threshold 2%%)","labels":{"team":"payments","env":"prod","region":"eu-west-1"},"attempt":1}`, i%10000+1, id, i%10000+1)
		stmts = append(stmts,
			S(`INSERT INTO outbox (call_id, run_id, payload, created_at) VALUES (?, ?, ?, ?)`, id+":call", id, payload, now),
			S(`INSERT INTO history_export (run_id, payload, created_at) VALUES (?, ?, ?)`, id, payload[:200], now))
	}
	_, err := st.rq.Exec(ctx, stmts...)
	return nil, err
}

func (s *Server) expire(ctx context.Context, st *Store, q map[string]string) (any, error) {
	keep := atoi(q["keep"], 20000)
	res, err := st.rq.Exec(ctx,
		S(`DELETE FROM outbox WHERE id <= (SELECT coalesce(max(id), 0) FROM outbox) - ?`, keep),
		S(`DELETE FROM history_export WHERE id <= (SELECT coalesce(max(id), 0) FROM history_export) - ?`, keep))
	if err != nil {
		return nil, err
	}
	return map[string]any{"deleted": res[0].RowsAffected + res[1].RowsAffected}, nil
}

func (s *Server) expireChunk(_ context.Context, st *Store, q map[string]string) (any, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	keep, chunk := atoi(q["keep"], 20000), atoi(q["chunk"], 500)
	deleted := map[string]int64{}
	txs := 0
	for _, t := range []string{"outbox", "history_export", "results", "runs"} {
		for {
			r, err := st.rq.Query(ctx, Linearizable, S("SELECT count(*) FROM "+t))
			if err != nil {
				return nil, err
			}
			v, _ := One(r)
			n, _ := v.(int64)
			if n <= keep {
				break
			}
			k := min(n-keep, chunk)
			res, err := st.rq.Exec(ctx, S(fmt.Sprintf("DELETE FROM %s WHERE rowid IN (SELECT rowid FROM %s ORDER BY rowid LIMIT ?)", t, t), k))
			if err != nil {
				return nil, err
			}
			deleted[t] += res[0].RowsAffected
			txs++
		}
	}
	return map[string]any{"deleted": deleted, "transactions": txs}, nil
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
	out := map[string]any{"data_dir_kb": dirSize(s.dataDir) / 1024}
	for k, v := range s.procMem() {
		out[k] = v
	}
	for _, p := range []string{"page_count", "freelist_count", "page_size"} {
		r, err := st.rq.Query(ctx, None, S("PRAGMA "+p))
		if v, found := One(r); err == nil && found {
			out[p] = v
		} else if err != nil {
			out[p+"_error"] = err.Error()
		}
	}
	if q["counts"] == "1" {
		counts := map[string]int64{}
		for _, t := range tables {
			r, _ := st.rq.Query(ctx, Linearizable, S("SELECT count(*) FROM "+t))
			v, _ := One(r)
			counts[t], _ = v.(int64)
		}
		out["counts"] = counts
	}
	return out, nil
}

// rowHash is the order-independent per-table sum shared with cmd/ctl: the
// same values give the same sum whether read from rqlite or from a file.
type rowHash struct {
	count int64
	sum   uint64
}

func (h *rowHash) add(vals []any) {
	f := fnv.New64a()
	for _, v := range vals {
		if b, ok := v.([]byte); ok {
			v = string(b)
		}
		fmt.Fprintf(f, "%v\x1f", v)
	}
	h.sum += f.Sum64()
	h.count++
}

func (h *rowHash) out() map[string]any {
	return map[string]any{"rows": h.count, "sum": fmt.Sprintf("%016x", h.sum)}
}

// rqChecksums reads every table through rqlite at the given level: none
// reads this member's own copy, to compare members with one another.
func rqChecksums(ctx context.Context, rq *RQ, lvl Level) (map[string]map[string]any, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	out := map[string]map[string]any{}
	for _, t := range tables {
		r, err := rq.Query(ctx, lvl, S("SELECT * FROM "+t))
		if err != nil {
			return nil, fmt.Errorf("%s: %w", t, err)
		}
		var h rowHash
		for _, row := range r[0].Raw {
			vals := make([]any, len(row))
			for i, v := range row {
				vals[i] = norm(v)
			}
			h.add(vals)
		}
		out[t] = h.out()
	}
	return out, nil
}

func fileChecksums(ctx context.Context, db *sql.DB) (map[string]map[string]any, error) {
	out := map[string]map[string]any{}
	for _, t := range tables {
		rows, err := db.QueryContext(ctx, "SELECT * FROM "+t)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", t, err)
		}
		cols, _ := rows.Columns()
		var h rowHash
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
			h.add(vals)
		}
		rows.Close()
		out[t] = h.out()
	}
	return out, nil
}

// leaderAPI is the leader's HTTP API, from its Raft address (the ports are
// fixed in this harness).
func (s *Server) leaderAPI(ctx context.Context) (string, error) {
	l, _, _ := s.rqStatus(ctx)
	if l == "" {
		return "", fmt.Errorf("%w: no leader", errUnavailable)
	}
	ip, _, _ := strings.Cut(l, ":")
	return "http://" + ip + ":4001", nil
}

// backup takes rqlite's online backup (a SQLite file) from the leader.
func (s *Server) backup(_ context.Context, st *Store, q map[string]string) (any, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	dir := q["dir"]
	if dir == "" {
		dir = "/out/backup"
	}
	t := time.Now()
	api, err := s.leaderAPI(ctx)
	if err != nil {
		return nil, err
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", api+"/db/backup", nil)
	resp, err := st.rq.c.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("backup: %d %s", resp.StatusCode, b)
	}
	dumpMs := time.Since(t).Milliseconds()
	_ = os.MkdirAll(dir, 0o755)
	path := filepath.Join(dir, "control.db")
	if err := os.WriteFile(path, b, 0o644); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite3", "file:"+path+"?mode=ro")
	if err != nil {
		return nil, err
	}
	defer db.Close()
	sums, err := fileChecksums(ctx, db)
	if err != nil {
		return nil, err
	}
	var next int64
	_ = db.QueryRowContext(ctx, `SELECT next FROM allocators WHERE name = 'arrival'`).Scan(&next)
	return map[string]any{"dump_ms": dumpMs, "files": map[string]int{"control.db": len(b)}, "checksums": sums, "allocator_next": next}, nil
}

// restore loads a backup into this (fresh) cluster in one step. The file
// is changed first, on a private copy: owners are cleared and the
// incarnation replaced, so the old incarnation is never visible in the
// restored installation, not even for a moment.
func (s *Server) restore(_ context.Context, st *Store, q map[string]string) (any, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	dir := q["dir"]
	if dir == "" {
		dir = "/out/backup"
	}
	t := time.Now()
	tmp, err := os.MkdirTemp("", "restore")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tmp)
	path := filepath.Join(tmp, "control.db")
	src, err := os.ReadFile(filepath.Join(dir, "control.db"))
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, src, 0o644); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite3", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	from, inc := "", newIncarnation()
	_ = db.QueryRowContext(ctx, `SELECT value FROM cluster_meta WHERE key = 'incarnation'`).Scan(&from)
	for _, x := range []string{
		`PRAGMA journal_mode = DELETE`,
		`DELETE FROM health`,
		`UPDATE leases SET owner = NULL, expires_at = 0`,
		`UPDATE cluster_meta SET value = '` + inc + `' WHERE key = 'incarnation'`,
	} {
		if _, err := db.ExecContext(ctx, x); err != nil {
			db.Close()
			return nil, fmt.Errorf("%s: %w", x, err)
		}
	}
	db.Close()
	body, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	api, err := s.leaderAPI(ctx)
	if err != nil {
		return nil, err
	}
	req, _ := http.NewRequestWithContext(ctx, "POST", api+"/db/load", bytes.NewReader(body))
	req.Header.Set("content-type", "application/octet-stream")
	resp, err := st.rq.c.Do(req)
	if err != nil {
		return nil, err
	}
	rb, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || bytes.Contains(rb, []byte(`"error"`)) {
		return nil, fmt.Errorf("load: %d %s", resp.StatusCode, rb)
	}
	loadMs := time.Since(t).Milliseconds()
	sums, err := rqChecksums(ctx, st.rq, Linearizable)
	if err != nil {
		return nil, err
	}
	return map[string]any{"replay_ms": loadMs, "rows": map[string]int{}, "checksums": sums, "from_incarnation": from, "incarnation": inc, "load_response": string(rb)}, nil
}
