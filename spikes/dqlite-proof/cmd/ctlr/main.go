// ctlr is one member of the rqlite proof cluster: it supervises a local
// rqlited (as a production member would, beside Bun) and puts the same
// Toposcope-shaped operations and the same HTTP API as cmd/ctl in front of
// it, on TCP for the runner and on a Unix socket for Bun.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
)

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

type Server struct {
	node    string
	ip      string
	dataDir string
	rq      *RQ
	proc    *exec.Cmd
	store   atomic.Pointer[Store]
	workers *Workers
	stats   *Stats
	acks    *Acks
	started time.Time
	inc     atomic.Value
	fenced  atomic.Bool
}

func (s *Server) localInc() string {
	v, _ := s.inc.Load().(string)
	return v
}

// fenceLoop: as in cmd/ctl. A member with no incarnation adopts the
// installation's; one that remembers another is fenced.
func (s *Server) fenceLoop() {
	path := filepath.Join(s.dataDir, "incarnation")
	if b, err := os.ReadFile(path); err == nil {
		s.inc.Store(strings.TrimSpace(string(b)))
	}
	for {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		r, err := s.rq.Query(ctx, Weak, S(`SELECT value FROM cluster_meta WHERE key = 'incarnation'`))
		cancel()
		if v, found := One(r); err == nil && found {
			cur, _ := v.(string)
			switch local := s.localInc(); {
			case cur == "":
			case local == "":
				_ = os.WriteFile(path, []byte(cur), 0o644)
				s.inc.Store(cur)
				log.Printf("%s joins incarnation %s", s.node, cur)
			case local != cur:
				if !s.fenced.Load() {
					log.Printf("%s FENCED: it belongs to incarnation %s, the installation is %s", s.node, local, cur)
				}
				s.fenced.Store(true)
			default:
				s.fenced.Store(false)
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
}

// startRqlited runs rqlited as a child and exits with it.
func (s *Server) startRqlited() {
	ip := s.ip
	args := []string{
		"-node-id", s.node,
		"-http-addr", "0.0.0.0:4001", "-http-adv-addr", ip + ":4001",
		"-raft-addr", "0.0.0.0:4002", "-raft-adv-addr", ip + ":4002",
		"-bootstrap-expect", "3", "-join", env("RQ_JOIN", ip+":4002"),
		"-raft-log-level", "WARN",
	}
	if env("TLS", "1") != "0" {
		// MTLS=1: each installation has its own certificate authority and a
		// member must present a certificate from it, so a member of another
		// installation (an old one coming back after a restore) cannot
		// connect at all. Otherwise one certificate is shared by everyone.
		dir := "/etc/dqproof"
		if env("MTLS", "0") == "1" {
			dir += "/" + env("CERT_SET", "a")
		}
		args = append(args, "-node-cert", dir+"/cert.pem", "-node-key", dir+"/key.pem",
			"-node-ca-cert", dir+"/cert.pem", "-node-verify-server-name", "dqproof")
		if env("MTLS", "0") == "1" {
			args = append(args, "-node-verify-client")
		}
	}
	args = append(args, strings.Fields(os.Getenv("RQ_ARGS"))...)
	args = append(args, filepath.Join(s.dataDir, "rqlite"))
	log.Printf("rqlited %s", strings.Join(args, " "))
	cmd := exec.Command("/usr/local/bin/rqlited", args...)
	cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr
	if err := cmd.Start(); err != nil {
		log.Fatalf("rqlited: %v", err)
	}
	s.proc = cmd
	go func() {
		err := cmd.Wait()
		log.Fatalf("rqlited exited: %v", err)
	}()
}

func main() {
	node := env("NODE", "n1")
	addr := env("ADDR", "127.0.0.1:9001")
	ip, _, _ := strings.Cut(addr, ":")
	dataDir := env("DATA", "/data")

	_ = os.MkdirAll("/out/acks", 0o755)
	stats := &Stats{}
	s := &Server{node: node, ip: ip, dataDir: dataDir, rq: newRQ("http://127.0.0.1:4001"), stats: stats, acks: openAcks("/out/acks/" + node + ".jsonl"), started: time.Now()}
	s.startRqlited()

	go func() {
		for {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			req, _ := http.NewRequestWithContext(ctx, "GET", "http://127.0.0.1:4001/readyz", nil)
			resp, err := s.rq.c.Do(req)
			cancel()
			if err == nil {
				resp.Body.Close()
				if resp.StatusCode == 200 {
					break
				}
			}
			time.Sleep(200 * time.Millisecond)
		}
		st := &Store{rq: s.rq, node: node}
		s.workers = &Workers{s: st, acks: s.acks, stats: stats, monitors: 100, inc: s.localInc}
		s.store.Store(st)
		go s.fenceLoop()
		s.workers.Start()
		log.Printf("%s ready at %s", node, addr)
	}()

	go func() { log.Fatal(http.ListenAndServe(":8080", s.routes())) }()

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
	// rqlited steps down on SIGTERM (-raft-shutdown-stepdown is on).
	_ = s.proc.Process.Signal(syscall.SIGTERM)
	done := make(chan struct{})
	go func() { _, _ = s.proc.Process.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(8 * time.Second):
	}
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

func (s *Server) op(fn func(ctx context.Context, st *Store, q map[string]string) (any, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		st := s.store.Load()
		if st == nil {
			reply(w, 503, map[string]any{"error": "not ready"})
			return
		}
		switch r.URL.Path {
		case "/q", "/mem", "/checksums":
		default:
			if s.fenced.Load() {
				reply(w, 503, map[string]any{"error": "fenced: this member belongs to another incarnation"})
				return
			}
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
			switch {
			case errors.Is(err, errStale), errors.Is(err, errHeld), errors.Is(err, errDuplicate):
				code = 409
			case errors.Is(err, errUnavailable):
				code = 503
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
		_, err := st.rq.Exec(ctx, S(`CREATE TABLE IF NOT EXISTS health (id TEXT PRIMARY KEY, at INTEGER NOT NULL)`), S(`INSERT INTO health (id, at) VALUES (?, ?)`, q["id"], nowMs()))
		return nil, err
	}))
	m.HandleFunc("POST /alloc", s.op(func(ctx context.Context, st *Store, q map[string]string) (any, error) {
		a, b, err := st.AllocBlock(ctx, s.localInc(), 1000)
		return map[string]any{"s": a, "e": b, "inc": s.localInc()}, err
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
		lvl := Level(q["level"])
		if lvl == "" {
			lvl = Linearizable
		}
		r, err := st.rq.Query(ctx, lvl, S(q["sql"]))
		if err != nil {
			return nil, err
		}
		return Rows(r[0]), nil
	}))
	m.HandleFunc("POST /bench", s.op(s.bench))
	m.HandleFunc("POST /seed", s.op(s.seed))
	m.HandleFunc("POST /churn", s.op(s.churn))
	m.HandleFunc("POST /expire", s.op(s.expire))
	m.HandleFunc("POST /expire-chunk", s.op(s.expireChunk))
	m.HandleFunc("POST /vacuum", s.op(func(ctx context.Context, st *Store, q map[string]string) (any, error) {
		_, err := st.rq.Exec(ctx, S(`VACUUM`))
		return nil, err
	}))
	m.HandleFunc("GET /mem", s.op(s.mem))
	m.HandleFunc("GET /checksums", s.op(func(ctx context.Context, st *Store, q map[string]string) (any, error) {
		lvl := Level(q["level"])
		if lvl == "" {
			lvl = Linearizable
		}
		return rqChecksums(ctx, st.rq, lvl)
	}))
	m.HandleFunc("POST /backup", s.op(s.backup))
	m.HandleFunc("POST /selftest/batch", s.op(s.batchTest))
	m.HandleFunc("POST /restore", s.op(s.restore))
	return m
}

// rqStatus is the part of rqlited's /status the runner needs.
func (s *Server) rqStatus(ctx context.Context) (leader string, roles map[string]string, state string) {
	m, err := s.rq.get(ctx, "/status")
	if err != nil {
		return "", nil, ""
	}
	st, _ := m["store"].(map[string]any)
	if l, ok := st["leader"].(map[string]any); ok {
		leader, _ = l["addr"].(string)
	}
	if r, ok := st["raft"].(map[string]any); ok {
		state, _ = r["state"].(string)
	}
	roles = map[string]string{}
	if nodes, ok := st["nodes"].([]any); ok {
		for _, x := range nodes {
			n, _ := x.(map[string]any)
			a, _ := n["addr"].(string)
			if suf, _ := n["suffrage"].(string); suf == "Voter" {
				roles[a] = "voter"
			} else {
				roles[a] = strings.ToLower(suf)
			}
		}
	}
	return
}

func (s *Server) status(w http.ResponseWriter, r *http.Request) {
	out := map[string]any{"node": s.node, "addr": s.ip + ":4002", "ready": s.store.Load() != nil, "up_s": int(time.Since(s.started).Seconds())}
	ctx, cancel := context.WithTimeout(r.Context(), 500*time.Millisecond)
	defer cancel()
	leader, roles, state := s.rqStatus(ctx)
	if leader != "" {
		out["leader"] = leader
	}
	out["roles"], out["raft_state"] = roles, state
	mem := s.procMem()
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	out["rss_kb"], out["hwm_kb"], out["go_sys_kb"], out["go_heap_kb"] = mem["rss_kb"], mem["hwm_kb"], ms.Sys/1024, ms.HeapInuse/1024
	out["mem"] = mem
	out["stats"] = s.stats.JSON()
	out["incarnation"], out["fenced"] = s.localInc(), s.fenced.Load()
	if st := s.store.Load(); st != nil {
		out["retries"], out["replayed"] = st.retries.Load(), st.replayed.Load()
	}
	if s.workers != nil {
		out["workers"] = s.workers.on.Load()
	}
	reply(w, 200, out)
}

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
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		ok, err := st.CheckSession(ctx, r.URL.Query().Get("s"))
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

// Memory, per process: this Go service, its rqlited, and any Bun process
// in the member; plus the container's cgroup.

func pidStatus(pid int) (rss, hwm int64, name string) {
	f, err := os.Open(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		t := sc.Text()
		var v int64
		switch {
		case strings.HasPrefix(t, "Name:"):
			name = strings.TrimSpace(strings.TrimPrefix(t, "Name:"))
		case strings.HasPrefix(t, "VmRSS:"):
			fmt.Sscanf(strings.TrimPrefix(t, "VmRSS:"), "%d", &v)
			rss = v
		case strings.HasPrefix(t, "VmHWM:"):
			fmt.Sscanf(strings.TrimPrefix(t, "VmHWM:"), "%d", &v)
			hwm = v
		}
	}
	return
}

func cgroupKB(file string) int64 {
	b, err := os.ReadFile("/sys/fs/cgroup/" + file)
	if err != nil {
		return -1
	}
	v, _ := strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64)
	return v / 1024
}

// procMem: rss_kb and hwm_kb are this service plus its rqlited, the
// storage side of the member, so they compare with cmd/ctl's single
// process. Bun and the whole container are reported beside them.
func (s *Server) procMem() map[string]int64 {
	out := map[string]int64{}
	r1, h1, _ := pidStatus(os.Getpid())
	out["ctl_rss_kb"], out["ctl_hwm_kb"] = r1, h1
	if s.proc != nil && s.proc.Process != nil {
		r2, h2, _ := pidStatus(s.proc.Process.Pid)
		out["rqlited_rss_kb"], out["rqlited_hwm_kb"] = r2, h2
	}
	out["rss_kb"], out["hwm_kb"] = out["ctl_rss_kb"]+out["rqlited_rss_kb"], out["ctl_hwm_kb"]+out["rqlited_hwm_kb"]
	ents, _ := os.ReadDir("/proc")
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		if r, h, name := pidStatus(pid); name == "bun" {
			out["bun_rss_kb"] += r
			out["bun_hwm_kb"] += h
		}
	}
	out["cgroup_current_kb"], out["cgroup_peak_kb"] = cgroupKB("memory.current"), cgroupKB("memory.peak")
	return out
}
