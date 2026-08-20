export const LIVE_DEFAULTS = {
  logs: 20,
  metrics: 2,
  traces: 1,
} as const;

export type LiveRates = {
  logs: number;
  metrics: number;
  traces: number;
};

export type LiveArgs = LiveRates & {
  forMs: number;
};

const maxForMs = 60 * 60 * 1000;

function parseCount(raw: string, name: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a whole number, got "${raw}"`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`${name} is too large`);
  }
  return n;
}

export function parseForMs(raw: string): number {
  const match = /^(\d+)(ms|s|m)?$/.exec(raw.trim());
  if (!match?.[1]) {
    throw new Error(`--for must look like 12s, 1m, or 2500ms, got "${raw}"`);
  }
  const n = Number(match[1]);
  const unit = match[2] ?? "s";
  const ms = unit === "ms" ? n : unit === "m" ? n * 60_000 : n * 1000;
  if (ms > maxForMs) {
    throw new Error("--for is capped at 1h");
  }
  return ms;
}

function takeFlag(
  argv: string[],
  i: number,
  name: string,
): { value: string; next: number } {
  const cur = argv[i];
  if (!cur) {
    throw new Error(`missing --${name}`);
  }
  if (cur.startsWith(`--${name}=`)) {
    return { value: cur.slice(name.length + 3), next: i + 1 };
  }
  const next = argv[i + 1];
  if (cur === `--${name}`) {
    if (!next || next.startsWith("--")) {
      throw new Error(`--${name} needs a value`);
    }
    return { value: next, next: i + 2 };
  }
  throw new Error(`unknown load:live flag "${cur}"`);
}

export function parseLiveArgs(argv: string[]): LiveArgs {
  const out: LiveArgs = { ...LIVE_DEFAULTS, forMs: 0 };
  let i = 0;
  while (i < argv.length) {
    const cur = argv[i];
    if (!cur) {
      break;
    }
    const name = cur.startsWith("--logs")
      ? "logs"
      : cur.startsWith("--metrics")
        ? "metrics"
        : cur.startsWith("--traces")
          ? "traces"
          : cur.startsWith("--for")
            ? "for"
            : null;
    if (!name) {
      throw new Error(`unknown load:live flag "${cur}"`);
    }
    const taken = takeFlag(argv, i, name);
    if (name === "for") {
      out.forMs = parseForMs(taken.value);
    } else {
      out[name] = parseCount(taken.value, `--${name}`);
    }
    i = taken.next;
  }
  if (out.logs === 0 && out.metrics === 0 && out.traces === 0) {
    throw new Error("at least one of --logs / --metrics / --traces must be > 0");
  }
  return out;
}
