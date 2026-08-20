export function shouldFire(args: {
  value: number;
  threshold: number;
  lastFiredAt: number | null;
  now: number;
  cooldownMs: number;
  silencedUntil?: number | null;
}): boolean {
  if (args.silencedUntil != null && args.now < args.silencedUntil) {
    return false;
  }
  if (args.value < args.threshold) {
    return false;
  }
  if (args.lastFiredAt === null) {
    return true;
  }
  return args.now - args.lastFiredAt >= args.cooldownMs;
}

/** Refused agg never pages. */
export function shouldDeliver(args: {
  refused: boolean;
  value: number;
  threshold: number;
  lastFiredAt: number | null;
  now: number;
  cooldownMs: number;
  silencedUntil?: number | null;
}): boolean {
  if (args.refused) {
    return false;
  }
  return shouldFire(args);
}
