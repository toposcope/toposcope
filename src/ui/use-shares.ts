import { useEffect, useState } from "react";
import type { ShareView } from "./share-cover";

/**
 * The instance's shares, for Copy embed on a metric panel (#228): read once per page, and again
 * whenever Settings → Shares changes them.
 */

let known: ShareView[] | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<(shares: ShareView[]) => void>();

function load(): Promise<void> {
  loading ??= fetch("/api/shares")
    .then((res) => (res.ok ? (res.json() as Promise<{ shares: ShareView[] }>) : { shares: [] }))
    .then((json) => announceShares(json.shares))
    .catch(() => announceShares([]));
  return loading;
}

/** Settings → Shares tells every panel what it now holds. */
export function announceShares(shares: ShareView[]): void {
  known = shares;
  for (const listener of listeners) listener(shares);
}

export function useShares(): ShareView[] {
  const [shares, setShares] = useState<ShareView[]>(known ?? []);
  useEffect(() => {
    listeners.add(setShares);
    if (known === null) {
      void load();
    }
    return () => {
      listeners.delete(setShares);
    };
  }, []);
  return shares;
}
