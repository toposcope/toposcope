import { useSyncExternalStore } from "react";
import type { Health } from "../shared/boot";

/**
 * The app or ClickHouse going away (33i–33l). Any failed `/api/` call asks `/api/health`; only a
 * health probe decides that something is down, and only a passing one says it is back. A 500 from
 * a bug, with health green, stays the caller's own error.
 */

export type OutageKind = "app" | "clickhouse";

export type OutageState =
  | { status: "ok" }
  | {
      status: "down";
      kind: OutageKind;
      since: number;
      attempt: number;
      nextAt: number;
      /** What the last probe or failed call said, for the screen's detail line. */
      detail: string | null;
      /** The boot phase when the app answers but is not ready yet. */
      phase: Health["phase"] | null;
    }
  | { status: "back"; downMs: number; at: number };

/** Waits between probes: 2 → 4 → 8 → 15 → 30 s, then every 30 s (33i). */
export const retryWaitsMs = [2_000, 4_000, 8_000, 15_000, 30_000] as const;

/** A short loss keeps the last paint under a band (33k); past this the full screen takes over. */
export const screenAfterMs = 15_000;

/** A call still open this long asks `/api/health` whether something below it is down. */
export const slowCallMs = 10_000;

/** How long the green "Back after …" band stays (33l). */
export const backBandMs = 4_000;

export function retryWaitMs(attempt: number): number {
  return retryWaitsMs[Math.min(Math.max(attempt, 1), retryWaitsMs.length) - 1] ?? 30_000;
}

export function outageScreen(state: OutageState, now: number): boolean {
  return state.status === "down" && now - state.since >= screenAfterMs;
}

export type ProbeResult =
  | { ok: true }
  | { ok: false; kind: OutageKind; phase: Health["phase"] | null; detail: string | null };

/** What one health answer means; `null` is no answer at all. */
export function classifyHealth(health: Health | null): ProbeResult {
  if (!health) {
    return { ok: false, kind: "app", phase: null, detail: null };
  }
  if (health.phase !== "ready") {
    return { ok: false, kind: "app", phase: health.phase, detail: null };
  }
  if (!health.clickhouse) {
    return { ok: false, kind: "clickhouse", phase: null, detail: null };
  }
  return { ok: true };
}

/**
 * A probe that timed out says nothing new: stalled calls can hold every connection the browser
 * keeps for this host, so the probe waits behind them. A known cause stays; an unknown one is the app.
 */
export function probeResult(state: OutageState, health: Health | null, timedOut: boolean): ProbeResult {
  if (!health && timedOut && state.status === "down") {
    return { ok: false, kind: state.kind, phase: state.phase, detail: state.detail };
  }
  return classifyHealth(health);
}

/** The next state after a probe, and when to probe again (null: stop). */
export function afterProbe(
  state: OutageState,
  result: ProbeResult,
  now: number,
  lastCallError: string | null,
): OutageState {
  if (result.ok) {
    return state.status === "down" ? { status: "back", downMs: now - state.since, at: now } : state;
  }
  const attempt = state.status === "down" ? state.attempt + 1 : 1;
  return {
    status: "down",
    kind: result.kind,
    since: state.status === "down" ? state.since : now,
    attempt,
    nextAt: now + retryWaitMs(attempt),
    detail: result.detail ?? (result.kind === "clickhouse" ? lastCallError : null),
    phase: result.phase,
  };
}

export function isOwnApi(url: string, origin: string): boolean {
  let path: string;
  try {
    const parsed = new URL(url, origin);
    if (parsed.origin !== origin) {
      return false;
    }
    path = parsed.pathname;
  } catch {
    return false;
  }
  return path.startsWith("/api/") && path !== "/api/health";
}

let state: OutageState = { status: "ok" };
const listeners = new Set<() => void>();
let rawFetch: typeof fetch | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let probing = false;
let lastCallError: string | null = null;

function set(next: OutageState) {
  if (next === state) {
    return;
  }
  state = next;
  for (const fn of listeners) {
    fn();
  }
}

function schedule(at: number) {
  if (timer) {
    clearTimeout(timer);
  }
  timer = setTimeout(() => void probe(), Math.max(0, at - Date.now()));
}

async function probe(): Promise<void> {
  if (probing || !rawFetch) {
    return;
  }
  probing = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  let health: Health | null = null;
  let timedOut = false;
  try {
    const res = await rawFetch("/api/health", { cache: "no-store", signal: AbortSignal.timeout(5_000) });
    health = (await res.json()) as Health;
  } catch (err) {
    health = null;
    timedOut = err instanceof DOMException && err.name === "TimeoutError";
  } finally {
    probing = false;
  }
  const was = state;
  const next = afterProbe(was, probeResult(was, health, timedOut), Date.now(), lastCallError);
  set(next);
  if (next.status === "down") {
    schedule(next.nextAt);
  } else if (next.status === "back" && was.status === "down") {
    lastCallError = null;
    window.dispatchEvent(new Event(backEvent));
    timer = setTimeout(() => set({ status: "ok" }), backBandMs);
  }
}

/** Fired once when a probe finds everything answering again; a hunt searches again on it. */
export const backEvent = "toposcope:back";

/** Probe now (Retry now, or the browser came back online). */
export function retryNow(): void {
  if (state.status === "down") {
    void probe();
  }
}

function suspect() {
  if (state.status !== "down") {
    void probe();
  }
}

/**
 * Watches every same-origin `/api/` call: no answer, or a 5xx, asks `/api/health` what is down.
 * An abort is the caller's own, never an outage.
 */
export function installOutageWatch(): void {
  if (rawFetch || typeof window === "undefined") {
    return;
  }
  const base = window.fetch.bind(window);
  rawFetch = base;
  const watched = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const ours = isOwnApi(url, window.location.origin);
    // A hung ClickHouse never fails a call, it stalls one: a slow call asks too (33j).
    const slow = ours ? setTimeout(suspect, slowCallMs) : null;
    try {
      const res = await base(input, init);
      if (ours && res.status >= 500) {
        void res
          .clone()
          .json()
          .then((body: { error?: unknown }) => {
            if (typeof body?.error === "string") {
              lastCallError = body.error.slice(0, 160);
            }
          })
          .catch(() => undefined);
        suspect();
      }
      return res;
    } catch (err) {
      if (ours && !(err instanceof DOMException && err.name === "AbortError")) {
        suspect();
      }
      throw err;
    } finally {
      if (slow) {
        clearTimeout(slow);
      }
    }
  };
  window.fetch = Object.assign(watched, { preconnect: base.preconnect }) as typeof fetch;
  window.addEventListener("online", retryNow);
}

/** A failed call that the outage screen speaks for: no answer at all. */
export function isNoAnswer(err: unknown): boolean {
  return err instanceof TypeError;
}

export function useOutage(): OutageState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
    () => state,
  );
}

export function outageNow(): OutageState {
  return state;
}
