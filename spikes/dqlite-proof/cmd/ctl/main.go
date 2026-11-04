// ctl is one member of the proof cluster: a dqlite node (via go-dqlite's app
// package) with the Toposcope-shaped operations behind a small HTTP API on
// TCP (for the runner) and on a Unix socket (for the Bun auth benchmark).
package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	dqlite "github.com/canonical/go-dqlite/v3"
	"github.com/canonical/go-dqlite/v3/app"
	"github.com/canonical/go-dqlite/v3/client"
)

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

type Server struct {
	app     *app.App
	node    string
	dataDir string
	db      atomic.Pointer[sql.DB]
	store   atomic.Pointer[Store]
	workers *Workers
	stats   *Stats
	acks    *Acks
	started time.Time
}

func main() {
	node := env("NODE", "n1")
	addr := env("ADDR", "127.0.0.1:9001")
	dataDir := env("DATA", "/data")
	latency, _ := strconv.Atoi(env("LATENCY_MS", "0"))

	opts := []app.Option{
		app.WithAddress(addr),
		app.WithRolesAdjustmentFrequency(time.Second),
		app.WithBusyTimeout(5 * time.Second),
		app.WithLogFunc(func(l client.LogLevel, format string, a ...interface{}) {
			if l >= client.LogWarn {
				log.Printf("dqlite %s: %s", l, fmt.Sprintf(format, a...))
			}
		}),
	}
	if join := os.Getenv("JOIN"); join != "" {
		opts = append(opts, app.WithCluster(strings.Split(join, ",")))
	}
	// TLS is on by default: production peers would use it, and only on this
	// path does go-dqlite put TCP keepalive and TCP_USER_TIMEOUT on peer
	// connections (see RESULTS.md, "a stranded transaction").
	if env("TLS", "1") != "0" {
		cert, err := tls.LoadX509KeyPair("/etc/dqproof/cert.pem", "/etc/dqproof/key.pem")
		if err != nil {
			log.Fatalf("tls: %v", err)
		}
		pem, _ := os.ReadFile("/etc/dqproof/cert.pem")
		pool := x509.NewCertPool()
		pool.AppendCertsFromPEM(pem)
		opts = append(opts, app.WithTLS(app.SimpleTLSConfig(cert, pool)))
	}
	if th, tr := env("SNAP_THRESHOLD", ""), env("SNAP_TRAILING", ""); th != "" && tr != "" {
		a, _ := strconv.ParseUint(th, 10, 64)
		b, _ := strconv.ParseUint(tr, 10, 64)
		opts = append(opts, app.WithSnapshotParams(dqlite.SnapshotParams{Threshold: a, Trailing: b}))
	}
	if latency > 0 {
		opts = append(opts, app.WithNetworkLatency(time.Duration(latency)*time.Millisecond))
	}
	a, err := app.New(dataDir, opts...)
	if err != nil {
		log.Fatalf("app.New: %v", err)
	}

	_ = os.MkdirAll("/out/acks", 0o755)
	stats := &Stats{}
	s := &Server{app: a, node: node, dataDir: dataDir, stats: stats, acks: openAcks("/out/acks/" + node + ".jsonl"), started: time.Now()}

	go func() {
		ctx := context.Background()
		if err := a.Ready(ctx); err != nil {
			log.Fatalf("ready: %v", err)
		}
		db, err := a.Open(ctx, "control")
		if err != nil {
			log.Fatalf("open: %v", err)
		}
		db.SetMaxOpenConns(32)
		db.SetMaxIdleConns(32)
		st := &Store{db: db, node: node}
		s.workers = &Workers{s: st, acks: s.acks, stats: stats, monitors: 100}
		s.db.Store(db)
		s.store.Store(st)
		s.workers.Start()
		log.Printf("%s ready at %s", node, addr)
	}()

	mux := s.routes()
	go func() { log.Fatal(http.ListenAndServe(":8080", mux)) }()

	sock := env("SOCK", "/run/ctl/ctl.sock")
	_ = os.MkdirAll("/run/ctl", 0o755)
	_ = os.Remove(sock)
	ln, err := net.Listen("unix", sock)
	if err != nil {
		log.Fatalf("unix listen: %v", err)
	}
	go func() { log.Fatal(http.Serve(ln, s.socketRoutes())) }()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	<-sig
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = a.Handover(ctx)
	_ = a.Close()
}

func reply(w http.ResponseWriter, code int, v any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func reqCtx(r *http.Request) (context.Context, context.CancelFunc) {
	ms, _ := strconv.Atoi(r.URL.Query().Get("timeout"))
	if ms <= 0 {
		ms = 2000
	}
	return context.WithTimeout(r.Context(), time.Duration(ms)*time.Millisecond)
}

// op wraps an operation: 503 until ready, the error text on failure, and the
// server-side duration in microseconds on success.
func (s *Server) op(fn func(ctx context.Context, st *Store, q map[string]string) (any, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		st := s.store.Load()
		if st == nil {
			reply(w, 503, map[string]any{"error": "not ready"})
			return
		}
		q := map[string]string{}
		for k, v := range r.URL.Query() {
			q[k] = v[0]
		}
		ctx, cancel := reqCtx(r)
		defer cancel()
		t := time.Now()
		v, err := fn(ctx, st, q)
		us := time.Since(t).Microseconds()
		if err != nil {
			code := 500
			if errors.Is(err, errStale) || errors.Is(err, errHeld) {
				code = 409
			}
			reply(w, code, map[string]any{"error": err.Error(), "us": us})
			return
		}
		reply(w, 200, map[string]any{"v": v, "us": us})
	}
}

func atoi(s string, d int64) int64 {
	if v, err := strconv.ParseInt(s, 10, 64); err == nil {
		return v
	}
	return d
}

func (s *Server) routes() *http.ServeMux {
	m := http.NewServeMux()
	m.HandleFunc("GET /status", s.status)
	m.HandleFunc("POST /init", s.op(func(ctx context.Context, st *Store, q map[string]string) (any, error) {
		return nil, st.Init(ctx, int(atoi(q["monitors"], 100)))
	}))
	m.HandleFunc("POST /workers", func(w http.ResponseWriter, r *http.Request) {
		if s.workers == nil {
			reply(w, 503, map[string]any{"error": "not ready"})
			return
		}
		s.workers.on.Store(r.URL.Query().Get("on") == "1")
		reply(w, 200, map[string]any{"on": s.workers.on.Load()})
	})
	m.HandleFunc("POST /session", s.op(func(ctx context.Context, st *Store, q map[string]string) (any, error) {
		return nil, st.CreateSession(ctx, q["id"], atoi(q["ttl"], 3600_000))
	}))
	m.HandleFunc("POST /hw", s.op(func(ctx context.Context, st *Store, q map[string]string) (any, error) {
		if _, err := st.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS health (id TEXT PRIMARY KEY, at INTEGER NOT NULL)`); err != nil {
			return nil, err
		}
		_, err := st.db.ExecContext(ctx, `INSERT INTO health (id, at) VALUES (?, ?)`, q["id"], nowMs())
		return nil, err
	}))
	m.HandleFunc("POST /revoke", s.op(func(ctx context.Context, st *Store, q map[string]string) (any, error) {
		return nil, st.RevokeSession(ctx, q["id"])
	}))
	m.HandleFunc("GET /check", s.op(func(ctx context.Context, st *Store, q map[string]string) (any, error) {
		return st.CheckSession(ctx, q["id"])
	}))
	m.HandleFunc("POST /token", s.op(func(ctx context.Context, st *Store, q map[string]string) (any, error) {
		return nil, st.CreateToken(ctx, q["id"])
	}))
	m.HandleFunc("POST /token/revoke", s.op(func(ctx context.Context, st *Store, q map[string]string) (any, error) {
		return nil, st.RevokeToken(ctx, q["id"])
	}))
	m.HandleFunc("GET /token/check", s.op(func(ctx context.Context, st *Store, q map[string]string) (any, error) {
		ok, gen, err := st.CheckToken(ctx, q["id"])
		return map[string]any{"valid": ok, "gen": gen}, err
	}))
	m.HandleFunc("GET /q", s.op(func(ctx context.Context, st *Store, q map[string]string) (any, error) {
		return queryRows(ctx, st.db, q["sql"])
	}))
	m.HandleFunc("POST /bench", s.op(s.bench))
	m.HandleFunc("POST /seed", s.op(s.seed))
	m.HandleFunc("POST /churn", s.op(s.churn))
	m.HandleFunc("POST /expire", s.op(s.expire))
	m.HandleFunc("POST /vacuum", s.op(func(ctx context.Context, st *Store, q map[string]string) (any, error) {
		_, err := st.db.ExecContext(ctx, `VACUUM`)
		return nil, err
	}))
	m.HandleFunc("GET /mem", s.op(s.mem))
	m.HandleFunc("GET /checksums", s.op(func(ctx context.Context, st *Store, q map[string]string) (any, error) {
		return checksums(ctx, st.db)
	}))
	m.HandleFunc("POST /backup", s.op(s.backup))
	m.HandleFunc("POST /restore", s.op(s.restore))
	return m
}

func (s *Server) status(w http.ResponseWriter, r *http.Request) {
	out := map[string]any{"node": s.node, "addr": s.app.Address(), "id": s.app.ID(), "ready": s.store.Load() != nil, "up_s": int(time.Since(s.started).Seconds())}
	ctx, cancel := context.WithTimeout(r.Context(), 500*time.Millisecond)
	defer cancel()
	// The local node's own view: it asks only itself.
	if cli, err := s.app.Client(ctx); err == nil {
		if l, err := cli.Leader(ctx); err == nil && l != nil {
			out["leader"] = l.Address
		}
		if nodes, err := cli.Cluster(ctx); err == nil {
			roles := map[string]string{}
			for _, n := range nodes {
				roles[n.Address] = n.Role.String()
			}
			out["roles"] = roles
		}
		cli.Close()
	}
	rss, hwm := procMem()
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	out["rss_kb"], out["hwm_kb"], out["go_sys_kb"], out["go_heap_kb"] = rss, hwm, ms.Sys/1024, ms.HeapInuse/1024
	out["stats"] = s.stats.JSON()
	if st := s.store.Load(); st != nil {
		var errs []string
		st.txErrs.Range(func(k, _ any) bool { errs = append(errs, k.(string)); return true })
		out["tx_conns_discarded"], out["tx_errors"] = st.discarded.Load(), errs
	}
	if s.workers != nil {
		out["workers"] = s.workers.on.Load()
	}
	reply(w, 200, out)
}

// The Unix socket: what Bun would call for every request's auth check.
func (s *Server) socketRoutes() *http.ServeMux {
	m := http.NewServeMux()
	m.HandleFunc("GET /ping", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	})
	m.HandleFunc("GET /auth", func(w http.ResponseWriter, r *http.Request) {
		st := s.store.Load()
		if st == nil {
			w.WriteHeader(503)
			return
		}
		ok, err := st.CheckSession(r.Context(), r.URL.Query().Get("s"))
		if err != nil {
			w.WriteHeader(503)
			return
		}
		if !ok {
			w.WriteHeader(401)
		}
		w.Write([]byte(strconv.FormatBool(ok)))
	})
	return m
}

func queryRows(ctx context.Context, db *sql.DB, q string) ([]map[string]any, error) {
	rows, err := db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols, _ := rows.Columns()
	var out []map[string]any
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		m := map[string]any{}
		for i, c := range cols {
			if b, ok := vals[i].([]byte); ok {
				m[c] = string(b)
			} else {
				m[c] = vals[i]
			}
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
