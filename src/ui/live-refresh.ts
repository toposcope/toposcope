/**
 * One clock for every Live resource. Each entry names its cadence; the
 * registry decides what is due, keeps one abort controller per entry, and
 * records when each resource last landed (`fetchedAt`). Freshness is a
 * property of the data, not of whichever loop happened to fetch it.
 */

/** Resolve `true` when the data landed; anything else leaves `fetchedAt` alone. */
export type RefreshRun = (signal: AbortSignal) => Promise<boolean | undefined | void>;

export type RefreshEntry = {
  key: string;
  everyMs: number;
  /** Entries sharing a lane never run at once; the longest cadence wins. */
  lane?: string;
  /** Keys this entry also refreshes when it lands (a full pass covers the delta). */
  covers?: string[];
  run: RefreshRun;
};

type Slot = {
  entry: RefreshEntry;
  startedAt: number;
  fetchedAt: number | undefined;
  ac: AbortController | null;
};

/** setInterval drifts; a 2s entry ticked at 1.98s is still due. */
export function dueSlackMs(everyMs: number): number {
  return Math.min(500, Math.floor(everyMs / 4));
}

export class LiveRefresh {
  private slots = new Map<string, Slot>();
  private listeners = new Set<() => void>();

  constructor(private readonly clock: () => number = Date.now) {}

  register(entry: RefreshEntry): void {
    const prev = this.slots.get(entry.key);
    if (prev) {
      prev.entry = entry;
      return;
    }
    this.slots.set(entry.key, {
      entry,
      startedAt: this.clock(),
      fetchedAt: undefined,
      ac: null,
    });
  }

  unregister(key: string): void {
    this.slots.get(key)?.ac?.abort();
    this.slots.delete(key);
  }

  /** Start every due entry. Returns the keys started. */
  tick(): string[] {
    const now = this.clock();
    const lanes = new Map<string, Slot[]>();
    const started: string[] = [];
    for (const slot of this.slots.values()) {
      const lane = slot.entry.lane ?? `key:${slot.entry.key}`;
      const list = lanes.get(lane) ?? [];
      list.push(slot);
      lanes.set(lane, list);
    }
    for (const slots of lanes.values()) {
      const due = slots
        .filter((slot) => this.isDue(slot, now))
        .sort((a, b) => b.entry.everyMs - a.entry.everyMs);
      const winner = due[0];
      if (!winner) {
        continue;
      }
      const busy = slots.find((slot) => slot.ac !== null);
      if (busy) {
        if (busy === winner || busy.entry.everyMs >= winner.entry.everyMs) {
          continue;
        }
        busy.ac?.abort();
        busy.ac = null;
      }
      for (const key of winner.entry.covers ?? []) {
        const covered = this.slots.get(key);
        if (covered && slots.includes(covered)) {
          covered.startedAt = now;
        }
      }
      this.start(winner, now);
      started.push(winner.entry.key);
    }
    return started;
  }

  /** Run these entries now (a replace search), resetting their clock. */
  runNow(keys: string[]): void {
    const now = this.clock();
    for (const key of keys) {
      const slot = this.slots.get(key);
      if (!slot) {
        continue;
      }
      slot.ac?.abort();
      slot.ac = null;
      this.start(slot, now);
    }
  }

  /** Something else just fetched these; restart their cadence from now. */
  touch(keys: string[], landed = false): void {
    const now = this.clock();
    for (const key of keys) {
      const slot = this.slots.get(key);
      if (!slot) {
        continue;
      }
      slot.startedAt = now;
      if (landed) {
        slot.fetchedAt = now;
      }
    }
    if (landed) {
      this.emit();
    }
  }

  abort(keys?: string[]): void {
    for (const [key, slot] of this.slots) {
      if (keys && !keys.includes(key)) {
        continue;
      }
      slot.ac?.abort();
      slot.ac = null;
    }
  }

  inflight(key: string): boolean {
    return this.slots.get(key)?.ac != null;
  }

  fetchedAt(key: string): number | undefined {
    return this.slots.get(key)?.fetchedAt;
  }

  /** Freshness to carry with a workspace's last paint. */
  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, slot] of this.slots) {
      if (slot.fetchedAt !== undefined) {
        out[key] = slot.fetchedAt;
      }
    }
    return out;
  }

  /** Restore a workspace paint's freshness (data restored without a fetch). */
  restore(fetchedAt: Record<string, number>): void {
    for (const [key, slot] of this.slots) {
      slot.fetchedAt = fetchedAt[key];
    }
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private isDue(slot: Slot, now: number): boolean {
    return now - slot.startedAt >= slot.entry.everyMs - dueSlackMs(slot.entry.everyMs);
  }

  private start(slot: Slot, now: number): void {
    const ac = new AbortController();
    slot.ac = ac;
    slot.startedAt = now;
    const { entry } = slot;
    void entry
      .run(ac.signal)
      .then((landed) => {
        if (landed !== true || ac.signal.aborted) {
          return;
        }
        const at = this.clock();
        slot.fetchedAt = at;
        for (const key of entry.covers ?? []) {
          const covered = this.slots.get(key);
          if (covered) {
            covered.fetchedAt = at;
          }
        }
        this.emit();
      })
      .catch(() => {
        // A failed or aborted refresh keeps last paint and its age.
      })
      .finally(() => {
        if (slot.ac === ac) {
          slot.ac = null;
        }
      });
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
