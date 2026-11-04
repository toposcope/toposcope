package main

// A thin client for the local rqlited's HTTP API. Nothing clever: every
// write is one POST to /db/execute (always with ?transaction for more than
// one statement), every read one POST to /db/query with an explicit level.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Stmt []any // SQL, then its positional arguments

func S(sql string, args ...any) Stmt { return append(Stmt{sql}, args...) }

type Result struct {
	Columns      []string `json:"columns"`
	Raw          [][]any  `json:"values"`
	RowsAffected int64    `json:"rows_affected"`
	LastInsertID int64    `json:"last_insert_id"`
	Error        string   `json:"error"`
}

var (
	// errUnavailable is a request rqlite did not answer with results: the
	// node could not reach a leader, leadership was lost, the request timed
	// out. For a write its outcome is unknown.
	errUnavailable = errors.New("unavailable")
	errStale       = errors.New("stale generation refused")
	errHeld        = errors.New("lease held by another owner")
	errDuplicate   = errors.New("operation already applied")
	errNotFound    = errors.New("not found")
)

// SQLError is a statement rqlite executed and SQLite refused. In a
// transaction it means nothing in the request was applied.
type SQLError struct{ Msg string }

func (e *SQLError) Error() string { return e.Msg }

// Assertion messages raised by the must view (see schema) map to errors.
func assertionErr(msg string) error {
	switch msg {
	case "stale":
		return errStale
	case "held":
		return errHeld
	case "duplicate":
		return errDuplicate
	}
	return &SQLError{msg}
}

type RQ struct {
	base string
	c    *http.Client
}

func newRQ(base string) *RQ {
	return &RQ{base: base, c: &http.Client{Transport: &http.Transport{MaxIdleConnsPerHost: 64}}}
}

func remaining(ctx context.Context) time.Duration {
	if d, ok := ctx.Deadline(); ok {
		return time.Until(d)
	}
	return 10 * time.Second
}

func (r *RQ) post(ctx context.Context, path string, params url.Values, body []byte, ctype string) ([]byte, int, error) {
	d := remaining(ctx)
	if d <= 0 {
		return nil, 0, context.DeadlineExceeded
	}
	params.Set("timeout", fmt.Sprintf("%dms", d.Milliseconds()))
	req, _ := http.NewRequestWithContext(ctx, "POST", r.base+path+"?"+strings.ReplaceAll(params.Encode(), "=&", "&"), bytes.NewReader(body))
	req.Header.Set("content-type", ctype)
	resp, err := r.c.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return b, resp.StatusCode, nil
}

func (r *RQ) call(ctx context.Context, path string, params url.Values, stmts []Stmt) ([]Result, error) {
	body, _ := json.Marshal(stmts)
	b, code, err := r.post(ctx, path, params, body, "application/json")
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errUnavailable, err)
	}
	if code != 200 {
		return nil, fmt.Errorf("%w: %d %s", errUnavailable, code, strings.TrimSpace(string(b)))
	}
	var out struct {
		Results []Result `json:"results"`
		Error   string   `json:"error"`
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil {
		return nil, fmt.Errorf("%w: bad response %q", errUnavailable, b)
	}
	if out.Error != "" {
		return nil, fmt.Errorf("%w: %s", errUnavailable, out.Error)
	}
	for _, res := range out.Results {
		if res.Error != "" {
			return out.Results, assertionErr(res.Error)
		}
	}
	return out.Results, nil
}

// Exec runs the statements as one atomic request. More than one statement
// always goes with ?transaction: without it rqlite carries on after a
// failed statement and commits the ones after it.
func (r *RQ) Exec(ctx context.Context, stmts ...Stmt) ([]Result, error) {
	p := url.Values{}
	if len(stmts) > 1 {
		p.Set("transaction", "")
	}
	return r.call(ctx, "/db/execute", p, stmts)
}

// ExecLoose is Exec without ?transaction, kept only for the batch test that
// shows why Exec never does that.
func (r *RQ) ExecLoose(ctx context.Context, stmts ...Stmt) ([]Result, error) {
	return r.call(ctx, "/db/execute", url.Values{}, stmts)
}

// Level is a read consistency level: linearizable for every security and
// ownership decision; weak and none only for measurement and diagnosis.
type Level string

const (
	Linearizable Level = "linearizable"
	Weak         Level = "weak"
	None         Level = "none"
)

func (r *RQ) Query(ctx context.Context, level Level, stmts ...Stmt) ([]Result, error) {
	p := url.Values{}
	p.Set("level", string(level))
	if level == Linearizable {
		d := remaining(ctx) - 50*time.Millisecond
		if d < 10*time.Millisecond {
			d = 10 * time.Millisecond
		}
		p.Set("linearizable_timeout", fmt.Sprintf("%dms", d.Milliseconds()))
	}
	return r.call(ctx, "/db/query", p, stmts)
}

// Rows is one query's rows as maps, numbers as int64 where they are integers.
func Rows(res Result) []map[string]any {
	var out []map[string]any
	for _, row := range res.Raw {
		m := map[string]any{}
		for i, c := range res.Columns {
			m[c] = norm(row[i])
		}
		out = append(out, m)
	}
	return out
}

func norm(v any) any {
	if n, ok := v.(json.Number); ok {
		if i, err := n.Int64(); err == nil {
			return i
		}
		f, _ := n.Float64()
		return f
	}
	return v
}

// One returns the single value of a one-row, one-column query.
func One(res []Result) (any, bool) {
	if len(res) == 0 || len(res[0].Raw) == 0 || len(res[0].Raw[0]) == 0 {
		return nil, false
	}
	return norm(res[0].Raw[0][0]), true
}

func (r *RQ) get(ctx context.Context, path string) (map[string]any, error) {
	req, _ := http.NewRequestWithContext(ctx, "GET", r.base+path, nil)
	resp, err := r.c.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var m map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&m); err != nil {
		return nil, err
	}
	return m, nil
}

// retry repeats an operation whose outcome was unknown, with the same
// statements (and so the same operation id), until it answers or the
// deadline passes. Only errUnavailable is retried: anything rqlite executed
// and refused is final.
func retry[T any](ctx context.Context, st *Store, fn func(attempt int) (T, error)) (T, error) {
	var v T
	var err error
	for attempt := 1; ; attempt++ {
		v, err = fn(attempt)
		if err == nil || !errors.Is(err, errUnavailable) || ctx.Err() != nil {
			return v, err
		}
		st.retries.Add(1)
		select {
		case <-ctx.Done():
			return v, err
		case <-time.After(50 * time.Millisecond):
		}
	}
}
