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

func pause(n Node) error  { return sh(n, "kill -STOP $(pidof ctl)") }
func resume(n Node) error { return sh(n, "kill -CONT $(pidof ctl)") }
