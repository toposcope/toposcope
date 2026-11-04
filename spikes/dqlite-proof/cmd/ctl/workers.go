package main

// Background workers, one set per node, all competing. They are written to be
// adversarial: an owner writes with the generation it remembers and never
// checks its own clock first, so a paused owner that wakes does write, and the
// fence in the database is what refuses it.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

type Acks struct {
	mu sync.Mutex
	f  *os.File
}

func openAcks(path string) *Acks {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		panic(err)
	}
	return &Acks{f: f}
}

// Write appends one acknowledged write. One write(2) per line, unbuffered, so
// it survives SIGKILL of the process (the page cache outlives the process).
func (a *Acks) Write(v map[string]any) {
	v["t"] = nowMs()
	b, _ := json.Marshal(v)
	b = append(b, '\n')
	a.mu.Lock()
	_, _ = a.f.Write(b)
	a.mu.Unlock()
}

type Counter struct {
	OK, Err, Stale atomic.Int64
}

type Stats struct {
	Runs, Links, Blocks, Claims, Renews Counter
	StaleRefused                        atomic.Int64
	LeasesLost                          atomic.Int64
}

func (s *Stats) JSON() map[string]any {
	c := func(c *Counter) map[string]int64 {
		return map[string]int64{"ok": c.OK.Load(), "err": c.Err.Load(), "stale": c.Stale.Load()}
	}
	return map[string]any{
		"runs": c(&s.Runs), "links": c(&s.Links), "blocks": c(&s.Blocks), "claims": c(&s.Claims), "renews": c(&s.Renews),
		"stale_refused": s.StaleRefused.Load(), "leases_lost": s.LeasesLost.Load(),
	}
}

type Workers struct {
	s        *Store
	acks     *Acks
	stats    *Stats
	on       atomic.Bool
	monitors int64
}

const leaseTTL = 3000 // ms

func (w *Workers) Start() {
	go w.leaseLoop("scheduler", 100*time.Millisecond, w.runOnce)
	go w.leaseLoop("link:peer-a", 150*time.Millisecond, w.linkOnce)
	go w.allocLoop(50 * time.Millisecond)
}

func opCtx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 2*time.Second)
}

func (w *Workers) leaseLoop(name string, tick time.Duration, work func(gen int64, seq int64) error) {
	var gen, seq int64
	for {
		time.Sleep(tick)
		if !w.on.Load() {
			gen = 0
			continue
		}
		if gen > 0 {
			seq++
			err := work(gen, seq)
			if errors.Is(err, errStale) {
				w.stats.StaleRefused.Add(1)
				w.stats.LeasesLost.Add(1)
				gen = 0
				continue
			}
			ctx, cancel := opCtx()
			err = w.s.Renew(ctx, name, gen, leaseTTL)
			cancel()
			switch {
			case err == nil:
				w.stats.Renews.OK.Add(1)
			case errors.Is(err, errStale):
				w.stats.Renews.Stale.Add(1)
				w.stats.LeasesLost.Add(1)
				gen = 0
			default:
				w.stats.Renews.Err.Add(1)
			}
			continue
		}
		ctx, cancel := opCtx()
		g, err := w.s.Claim(ctx, name, leaseTTL)
		cancel()
		switch {
		case err == nil:
			gen = g
			w.stats.Claims.OK.Add(1)
			w.acks.Write(map[string]any{"k": "claim", "name": name, "gen": g, "node": w.s.node})
		case errors.Is(err, errHeld):
		default:
			w.stats.Claims.Err.Add(1)
		}
	}
}

func (w *Workers) runOnce(gen, seq int64) error {
	monitor := seq%w.monitors + 1
	runID := fmt.Sprintf("%s-g%d-%d", w.s.node, gen, seq)
	ctx, cancel := opCtx()
	defer cancel()
	err := w.s.CommitRun(ctx, "scheduler", gen, monitor, runID, seq%7 != 0)
	switch {
	case err == nil:
		w.stats.Runs.OK.Add(1)
		w.acks.Write(map[string]any{"k": "run", "id": runID, "gen": gen, "m": monitor, "node": w.s.node})
	case errors.Is(err, errStale):
		w.stats.Runs.Stale.Add(1)
	default:
		w.stats.Runs.Err.Add(1)
	}
	return err
}

func (w *Workers) linkOnce(gen, seq int64) error {
	ctx, cancel := opCtx()
	defer cancel()
	pos, err := w.s.AdvanceLink(ctx, "link:peer-a", "peer-a", gen, 100)
	switch {
	case err == nil:
		w.stats.Links.OK.Add(1)
		w.acks.Write(map[string]any{"k": "link", "pos": pos, "gen": gen, "node": w.s.node})
	case errors.Is(err, errStale):
		w.stats.Links.Stale.Add(1)
	default:
		w.stats.Links.Err.Add(1)
	}
	return err
}

func (w *Workers) allocLoop(tick time.Duration) {
	for {
		time.Sleep(tick)
		if !w.on.Load() {
			continue
		}
		ctx, cancel := opCtx()
		s, e, err := w.s.AllocBlock(ctx, 1000)
		cancel()
		if err != nil {
			w.stats.Blocks.Err.Add(1)
			continue
		}
		w.stats.Blocks.OK.Add(1)
		w.acks.Write(map[string]any{"k": "block", "s": s, "e": e, "node": w.s.node})
	}
}
