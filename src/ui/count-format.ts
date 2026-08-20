import { useSyncExternalStore } from "react";

export const countFormats = ["human", "raw"] as const;
export type CountFormat = (typeof countFormats)[number];

const storageKey = "toposcope.countFormat";
const listeners = new Set<() => void>();

function isCountFormat(value: string | null): value is CountFormat {
  return value === "human" || value === "raw";
}

export function readCountFormat(): CountFormat {
  try {
    const raw = localStorage.getItem(storageKey);
    if (isCountFormat(raw)) {
      return raw;
    }
  } catch {
    // private mode / SSR
  }
  return "human";
}

export function setCountFormat(value: CountFormat): void {
  try {
    localStorage.setItem(storageKey, value);
  } catch {
    // ignore quota / private mode
  }
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === storageKey) {
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useCountFormat(): CountFormat {
  return useSyncExternalStore(subscribe, readCountFormat, () => "human");
}

function trimZeros(value: string): string {
  return value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function formatScaled(n: number): string {
  if (n >= 100) {
    return n.toFixed(0);
  }
  if (n >= 10) {
    return trimZeros(n.toFixed(1));
  }
  return trimZeros(n.toFixed(2));
}

/** Compact sidebar counts: 1.24K, 15.6M, 3.04M. */
export function formatCompactCount(n: number): string {
  if (!Number.isFinite(n)) {
    return "0";
  }
  const abs = Math.abs(Math.round(n));
  if (abs < 1000) {
    return String(abs);
  }
  if (abs < 1_000_000) {
    return `${formatScaled(abs / 1000)}K`;
  }
  if (abs < 1_000_000_000) {
    return `${formatScaled(abs / 1_000_000)}M`;
  }
  return `${formatScaled(abs / 1_000_000_000)}B`;
}

export function formatFieldCount(n: number, format: CountFormat): string {
  switch (format) {
    case "raw":
      return Math.round(n).toLocaleString("en-US");
    case "human":
      return formatCompactCount(n);
    default: {
      const _exhaustive: never = format;
      return _exhaustive;
    }
  }
}
