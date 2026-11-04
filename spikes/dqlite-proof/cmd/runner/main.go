// runner drives the proof: it brings the cluster up, runs Toposcope-shaped
// work against it, injects faults, measures, verifies and writes a report.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Node struct{ Name, IP, Container string }

var cluster = []Node{
	{"n1", "10.213.7.11", "dqproof-n1"},
	{"n2", "10.213.7.12", "dqproof-n2"},
	{"n3", "10.213.7.13", "dqproof-n3"},
}

// The members a backup is restored onto: two take the addresses of lost
// members n1 and n2, so an old member that comes back finds its old peers'
// addresses answered by the restored installation.
var fresh = []Node{
	{"f1", "10.213.7.11", "dqproof-f1"},
	{"f2", "10.213.7.12", "dqproof-f2"},
	{"f3", "10.213.7.23", "dqproof-f3"},
}

var (
	electionMs   = envInt("ELECTION_MS", 3000)
	label        = env("LABEL", "default")
	phases       = env("PHASES", "faults,latency,memory,backup")
	revTrials    = envInt("REV_TRIALS", 3)
	revModes     = env("REV_MODES", "partition,partition+cpu,pause+partition,asym-in,asym-out")
	pauseTrials  = envInt("PAUSE_TRIALS", 3)
	churnBatches = envInt("CHURN_BATCHES", 1000)
	results      = map[string]any{}
	resMu        sync.Mutex
	startedAt    = time.Now()
)

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
func envInt(k string, d int) int {
	if v, err := strconv.Atoi(os.Getenv(k)); err == nil {
		return v
	}
	return d
}

func logf(format string, a ...any) {
	fmt.Printf("[%6.1fs] %s\n", time.Since(startedAt).Seconds(), fmt.Sprintf(format, a...))
}

func record(k string, v any) {
	resMu.Lock()
	results[k] = v
	resMu.Unlock()
}

func others(n Node, set []Node) []Node {
	var out []Node
	for _, x := range set {
		if x.Name != n.Name {
			out = append(out, x)
		}
	}
	return out
}

func byAddr(addr string, set []Node) (Node, bool) {
	for _, n := range set {
		if strings.HasPrefix(addr, n.IP+":") {
			return n, true
		}
	}
	return Node{}, false
}

// HTTP to members.

type Resp struct {
	V     json.RawMessage `json:"v"`
	US    int64           `json:"us"`
	Error string          `json:"error"`
}

var httpc = &http.Client{Transport: &http.Transport{MaxIdleConnsPerHost: 64}}

func call(n Node, method, path string, timeout time.Duration) (Resp, int, error) {
	sep := "?"
	if strings.Contains(path, "?") {
		sep = "&"
	}
	url := fmt.Sprintf("http://%s:8080%s%stimeout=%d", n.IP, path, sep, timeout.Milliseconds())
	req, _ := http.NewRequest(method, url, nil)
	c := *httpc
	c.Timeout = timeout + 500*time.Millisecond
	resp, err := c.Do(req)
	if err != nil {
		return Resp{}, 0, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	var r Resp
	_ = json.Unmarshal(b, &r)
	if resp.StatusCode != 200 && r.Error == "" {
		r.Error = string(b)
	}
	return r, resp.StatusCode, nil
}

func ok(n Node, method, path string, timeout time.Duration) (Resp, error) {
	r, code, err := call(n, method, path, timeout)
	if err != nil {
		return r, err
	}
	if code != 200 {
		return r, fmt.Errorf("%s %s on %s: %d %s", method, path, n.Name, code, r.Error)
	}
	return r, nil
}

func must(n Node, method, path string, timeout time.Duration) Resp {
	r, err := ok(n, method, path, timeout)
	if err != nil {
		die("%v", err)
	}
	return r
}

type Status struct {
	Node   string            `json:"node"`
	Addr   string            `json:"addr"`
	Ready  bool              `json:"ready"`
	Leader string            `json:"leader"`
	Roles  map[string]string `json:"roles"`
	RSS    int64             `json:"rss_kb"`
	HWM    int64             `json:"hwm_kb"`
	GoSys  int64             `json:"go_sys_kb"`
	GoHeap int64             `json:"go_heap_kb"`
	Stats  map[string]any    `json:"stats"`
	Inc    string            `json:"incarnation"`
	Fenced bool              `json:"fenced"`
}

func status(n Node) (Status, error) {
	var s Status
	c := *httpc
	c.Timeout = time.Second
	resp, err := c.Get(fmt.Sprintf("http://%s:8080/status", n.IP))
	if err != nil {
		return s, err
	}
	defer resp.Body.Close()
	err = json.NewDecoder(resp.Body).Decode(&s)
	return s, err
}

func q(n Node, sql string) []map[string]any {
	r := must(n, "GET", "/q?sql="+urlq(sql), 30*time.Second)
	var rows []map[string]any
	_ = json.Unmarshal(r.V, &rows)
	return rows
}

func urlq(s string) string {
	r := strings.NewReplacer("%", "%25", " ", "%20", "&", "%26", "+", "%2B", "#", "%23", "'", "%27", "=", "%3D", "?", "%3F", "<", "%3C", ">", "%3E", ",", "%2C")
	return r.Replace(s)
}

func num(v any) int64 {
	switch x := v.(type) {
	case float64:
		return int64(x)
	case string:
		i, _ := strconv.ParseInt(x, 10, 64)
		return i
	}
	return 0
}

// leader asks every member for its view and returns the one they agree on.
func leader(set []Node) (Node, error) {
	votes := map[string]int{}
	for _, n := range set {
		if s, err := status(n); err == nil && s.Leader != "" {
			votes[s.Leader]++
		}
	}
	for addr, v := range votes {
		if v*2 > len(set) {
			if n, found := byAddr(addr, set); found {
				return n, nil
			}
		}
	}
	return Node{}, fmt.Errorf("no agreed leader: %v", votes)
}

// waitHealthy waits until every member is ready, all agree on a leader, all
// three are voters, and a write through each member commits.
func waitHealthy(set []Node, timeout time.Duration) time.Duration {
	t := time.Now()
	why := ""
	good := 0
	for time.Since(t) < timeout {
		why = healthProblem(set)
		if why == "" {
			good++
			if good == 3 {
				return time.Since(t)
			}
		} else {
			good = 0
		}
		time.Sleep(250 * time.Millisecond)
	}
	die("cluster %v not healthy after %s: %s", names(set), timeout, why)
	return 0
}

func healthProblem(set []Node) string {
	for _, n := range set {
		s, err := status(n)
		if err != nil {
			return n.Name + " status: " + err.Error()
		}
		if !s.Ready || s.Leader == "" {
			return fmt.Sprintf("%s ready=%v leader=%q", n.Name, s.Ready, s.Leader)
		}
		voters := 0
		for _, r := range s.Roles {
			if r == "voter" {
				voters++
			}
		}
		if voters < len(set) {
			return fmt.Sprintf("%s sees roles %v", n.Name, s.Roles)
		}
	}
	if _, err := leader(set); err != nil {
		return err.Error()
	}
	for _, n := range set {
		id := fmt.Sprintf("health-%s-%d", n.Name, time.Now().UnixNano())
		if _, err := ok(n, "POST", "/hw?id="+id, 2*time.Second); err != nil {
			return "write via " + n.Name + ": " + err.Error()
		}
	}
	return ""
}

func names(set []Node) []string {
	var out []string
	for _, n := range set {
		out = append(out, n.Name)
	}
	return out
}

func setWorkers(set []Node, on bool) {
	v := "0"
	if on {
		v = "1"
	}
	for _, n := range set {
		must(n, "POST", "/workers?on="+v, 2*time.Second)
	}
}

// Runner-driven writes: sessions created and revoked through every member,
// one writer per member, as a load balancer would spread them.

type Ack struct {
	ID string
	T  int64
}

type RBlock struct {
	S, E int64
	Inc  string
	T    int64
}

type Workload struct {
	mu       sync.Mutex
	created  []Ack
	revoked  []Ack
	blocks   []RBlock
	okTimes  []time.Time
	failures int
	stop     chan struct{}
	wg       sync.WaitGroup
	seq      int
}

func startWorkload(set []Node, prefix string) *Workload {
	w := &Workload{stop: make(chan struct{})}
	for i, n := range set {
		w.wg.Add(1)
		go func(i int, n Node) {
			defer w.wg.Done()
			for k := 0; ; k++ {
				select {
				case <-w.stop:
					return
				default:
				}
				id := fmt.Sprintf("%s-%s-%d", prefix, n.Name, k)
				_, err := ok(n, "POST", "/session?id="+id, time.Second)
				w.mu.Lock()
				if err != nil {
					w.failures++
					w.mu.Unlock()
					time.Sleep(20 * time.Millisecond)
					continue
				}
				now := time.Now()
				w.created = append(w.created, Ack{id, now.UnixMilli()})
				w.okTimes = append(w.okTimes, now)
				w.mu.Unlock()
				// An arrival block, recorded here at the runner as well as
				// by the member's own workers.
				if r, err := ok(n, "POST", "/alloc", time.Second); err == nil {
					var b struct {
						S, E int64
						Inc  string
					}
					_ = json.Unmarshal(r.V, &b)
					w.mu.Lock()
					w.blocks = append(w.blocks, RBlock{b.S, b.E, b.Inc, time.Now().UnixMilli()})
					w.mu.Unlock()
				}
				w.mu.Lock()
				var target string
				if k%5 == 4 {
					target = w.created[(k*7919)%len(w.created)].ID
				}
				w.mu.Unlock()
				if target != "" {
					peer := set[(i+1)%len(set)]
					if _, err := ok(peer, "POST", "/revoke?id="+target, time.Second); err == nil {
						now := time.Now()
						w.mu.Lock()
						w.revoked = append(w.revoked, Ack{target, now.UnixMilli()})
						w.okTimes = append(w.okTimes, now)
						w.mu.Unlock()
					}
				}
				time.Sleep(20 * time.Millisecond)
			}
		}(i, n)
	}
	return w
}

func (w *Workload) Stop() { close(w.stop); w.wg.Wait() }

// gap is the longest time with no acknowledged write from any member
// within [from, to]: how long a client behind the load balancer waits.
func (w *Workload) gap(from, to time.Time) time.Duration {
	w.mu.Lock()
	ts := append([]time.Time(nil), w.okTimes...)
	w.mu.Unlock()
	sort.Slice(ts, func(i, j int) bool { return ts[i].Before(ts[j]) })
	prev := from
	var max time.Duration
	for _, t := range ts {
		if t.Before(from) {
			continue
		}
		if t.After(to) {
			break
		}
		if d := t.Sub(prev); d > max {
			max = d
		}
		prev = t
	}
	if d := to.Sub(prev); d > max {
		max = d
	}
	return max
}

func main() {
	log.SetFlags(0)
	logf("dqlite proof, config %s (election timeout %d ms), phases %s", label, electionMs, phases)
	_ = os.MkdirAll("/out", 0o755)
	defer writeResults()

	logf("waiting for n1-n3")
	d := waitHealthy(cluster, 3*time.Minute)
	logf("cluster healthy in %s", d.Round(time.Millisecond))
	l, _ := leader(cluster)
	must(l, "POST", "/init?monitors=100", 30*time.Second)
	inc0 := waitIncarnation(cluster, "", time.Minute)
	logf("installation incarnation %s", inc0)
	record("config", map[string]any{"label": label, "election_timeout_ms": electionMs, "heartbeat_ms": electionMs / 10, "dqlite": "v1.18.7", "go_dqlite": "v3.0.4", "lease_ttl_ms": 3000, "snapshot": env("SNAP", "dqlite default (threshold 1024, trailing 8192)"), "peer_tls": true})

	if strings.Contains(phases, "guard") {
		guardTest()
	}
	if strings.Contains(phases, "faults") {
		faults()
	}
	if strings.Contains(phases, "pauses") {
		pauses()
	}
	if strings.Contains(phases, "budget") {
		memoryBudget()
	}
	if strings.Contains(phases, "latency") {
		latency()
	}
	if strings.Contains(phases, "memory") {
		memory()
	}
	if strings.Contains(phases, "backup") {
		backupRestore()
	}
	record("tls_mac_errors", macErrors(cluster))
	logf("done")
}

// waitIncarnation waits until every member has adopted the installation's
// incarnation (or the given one) and returns it.
func waitIncarnation(set []Node, want string, timeout time.Duration) string {
	t := time.Now()
	for time.Since(t) < timeout {
		got, same := "", true
		for _, n := range set {
			s, err := status(n)
			if err != nil || s.Inc == "" || (want != "" && s.Inc != want) || (got != "" && s.Inc != got) {
				same = false
				break
			}
			got = s.Inc
		}
		if same && got != "" {
			return got
		}
		time.Sleep(200 * time.Millisecond)
	}
	die("members of %v did not adopt incarnation %q", names(set), want)
	return ""
}

func die(format string, a ...any) {
	msg := fmt.Sprintf(format, a...)
	logf("FATAL: %s", msg)
	record("fatal", msg)
	writeResults()
	os.Exit(1)
}

func writeResults() {
	crit := criteria()
	resMu.Lock()
	results["criteria"] = crit
	b, _ := json.MarshalIndent(results, "", "  ")
	md := report(results, crit)
	resMu.Unlock()
	_ = os.WriteFile("/out/results.json", b, 0o644)
	_ = os.WriteFile("/out/report.md", []byte(md), 0o644)
	logf("wrote /out/results.json and /out/report.md")
}
