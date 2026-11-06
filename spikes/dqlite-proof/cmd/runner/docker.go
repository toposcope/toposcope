package main

// A minimal Docker Engine API client over the mounted socket: enough to
// kill, start and restart members and to run commands inside them.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

var dockerHTTP = &http.Client{
	Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", "/var/run/docker.sock")
		},
	},
	Timeout: 3 * time.Minute,
}

func dockerDo(method, path string, body any) ([]byte, int, error) {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, "http://docker"+path, rd)
	if body != nil {
		req.Header.Set("content-type", "application/json")
	}
	resp, err := dockerHTTP.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return b, resp.StatusCode, nil
}

func dockerSimple(method, path string) error {
	b, code, err := dockerDo(method, path, nil)
	if err != nil {
		return err
	}
	if code >= 300 && code != 304 {
		return fmt.Errorf("docker %s %s: %d %s", method, path, code, b)
	}
	return nil
}

func dkill(n Node, sig string) error {
	return dockerSimple("POST", "/containers/"+n.Container+"/kill?signal="+sig)
}
func dstart(n Node) error   { return dockerSimple("POST", "/containers/"+n.Container+"/start") }
func drestart(n Node) error { return dockerSimple("POST", "/containers/"+n.Container+"/restart?t=10") }

// dexec runs a command in a member and returns its output and exit code.
func dexec(n Node, cmd ...string) (string, int, error) {
	b, code, err := dockerDo("POST", "/containers/"+n.Container+"/exec", map[string]any{
		"AttachStdout": true, "AttachStderr": true, "Tty": true, "Cmd": cmd,
	})
	if err != nil {
		return "", -1, err
	}
	if code != 201 {
		return "", -1, fmt.Errorf("exec create: %d %s", code, b)
	}
	var created struct{ Id string }
	_ = json.Unmarshal(b, &created)
	out, _, err := dockerDo("POST", "/exec/"+created.Id+"/start", map[string]any{"Detach": false, "Tty": true})
	if err != nil {
		return "", -1, err
	}
	b, _, err = dockerDo("GET", "/exec/"+created.Id+"/json", nil)
	if err != nil {
		return string(out), -1, err
	}
	var info struct{ ExitCode int }
	_ = json.Unmarshal(b, &info)
	return string(out), info.ExitCode, nil
}

func sh(n Node, script string) error {
	out, code, err := dexec(n, "sh", "-c", script)
	if err != nil {
		return err
	}
	if code != 0 {
		return fmt.Errorf("%s: %q exited %d: %s", n.Name, script, code, out)
	}
	return nil
}

// partition cuts n off from its peers in both directions; the runner's own
// address is untouched, so it can still ask n what it believes.
func partition(n Node, peers []Node) error {
	script := ""
	for _, p := range peers {
		script += fmt.Sprintf("iptables -A INPUT -s %s -j DROP && iptables -A OUTPUT -d %s -j DROP && ", p.IP, p.IP)
	}
	return sh(n, script+"true")
}

func heal(n Node) error { return sh(n, "iptables -F INPUT && iptables -F OUTPUT") }

// pause stops the whole member: the Go service and, on rqlite, its rqlited.
func pause(n Node) error  { return sh(n, "kill -STOP $(pidof rqlited rqlited-patched ctlr ctl)") }
func resume(n Node) error { return sh(n, "kill -CONT $(pidof rqlited rqlited-patched ctlr ctl)") }

// throttle limits a member's CPU (nanocpus; 0 removes the limit).
func throttle(n Node, nanoCPUs int64) error {
	b, code, err := dockerDo("POST", "/containers/"+n.Container+"/update", map[string]any{"NanoCpus": nanoCPUs})
	if err != nil {
		return err
	}
	if code >= 300 {
		return fmt.Errorf("update %s: %d %s", n.Name, code, b)
	}
	return nil
}

// oneWay drops only what n receives from (in) or sends to (out) its peers.
func oneWay(n Node, peers []Node, dir string) error {
	script := ""
	for _, p := range peers {
		if dir == "in" {
			script += fmt.Sprintf("iptables -A INPUT -s %s -j DROP && ", p.IP)
		} else {
			script += fmt.Sprintf("iptables -A OUTPUT -d %s -j DROP && ", p.IP)
		}
	}
	return sh(n, script+"true")
}

var hostOut = os.Getenv("HOST_OUT")

// certSet is the installation the next created member belongs to (MTLS=1).
var certSet = "a"

// dcreate creates and starts a member outside Compose, with a fresh data
// volume, on the given address.
func dcreate(n Node, join string) error {
	envs := []string{"NODE=" + n.Name, "ADDR=" + n.IP + ":9001", "LATENCY_MS=" + os.Getenv("LATENCY_MS"),
		"SNAP_THRESHOLD=" + os.Getenv("SNAP_THRESHOLD"), "SNAP_TRAILING=" + os.Getenv("SNAP_TRAILING"), "TLS=" + os.Getenv("TLS")}
	if join != "" {
		envs = append(envs, "JOIN="+join)
	}
	var rqJoin []string
	for _, f := range fresh {
		rqJoin = append(rqJoin, f.IP+":4002")
	}
	envs = append(envs, "RQ_JOIN="+strings.Join(rqJoin, ","), "RQ_ARGS="+os.Getenv("RQ_ARGS"), "MTLS="+os.Getenv("MTLS"), "CERT_SET="+certSet, "RQLITED="+env("RQLITED", "rqlited"))
	body := map[string]any{
		"Image": "dqproof-ctl:local", "Env": envs, "Entrypoint": []string{"/usr/local/bin/" + ctlBin()},
		"HostConfig": map[string]any{
			"Init": true, "CapAdd": []string{"NET_ADMIN"}, "Binds": []string{hostOut + ":/out"},
			"Mounts": []map[string]any{{"Type": "volume", "Target": "/data"}}, "Memory": int64(4) << 30,
			"NetworkMode": "dqproof_net",
		},
		"NetworkingConfig": map[string]any{"EndpointsConfig": map[string]any{"dqproof_net": map[string]any{"IPAMConfig": map[string]any{"IPv4Address": n.IP}}}},
	}
	b, code, err := dockerDo("POST", "/containers/create?name="+n.Container, body)
	if err != nil {
		return err
	}
	if code != 201 {
		return fmt.Errorf("create %s: %d %s", n.Name, code, b)
	}
	return dstart(n)
}

func dremove(n Node) {
	_, _, _ = dockerDo("DELETE", "/containers/"+n.Container+"?force=true&v=true", nil)
}

func limit(n Node, memBytes, nanoCPUs int64) error {
	b, code, err := dockerDo("POST", "/containers/"+n.Container+"/update", map[string]any{"Memory": memBytes, "MemorySwap": memBytes, "NanoCpus": nanoCPUs})
	if err != nil {
		return err
	}
	if code >= 300 {
		return fmt.Errorf("update %s: %d %s", n.Name, code, b)
	}
	return nil
}

func inspect(n Node) map[string]any {
	b, _, _ := dockerDo("GET", "/containers/"+n.Container+"/json", nil)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	st, _ := m["State"].(map[string]any)
	return map[string]any{"oom_killed": st["OOMKilled"], "running": st["Running"], "restart_count": m["RestartCount"]}
}

// macErrors counts "bad record MAC" in each member's log.
func macErrors(set []Node) map[string]int {
	out := map[string]int{}
	for _, n := range set {
		b, _, err := dockerDo("GET", "/containers/"+n.Container+"/logs?stdout=1&stderr=1", nil)
		if err == nil {
			out[n.Name] = bytes.Count(b, []byte("bad record MAC"))
		}
	}
	return out
}
