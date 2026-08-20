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

const UNITS = [
  { suffix: "T", size: 1024 ** 4 },
  { suffix: "G", size: 1024 ** 3 },
  { suffix: "M", size: 1024 ** 2 },
  { suffix: "K", size: 1024 },
  { suffix: "B", size: 1 },
] as const;

type ByteUnit = (typeof UNITS)[number];

function pickUnit(n: number): ByteUnit {
  const abs = Math.abs(n);
  for (const unit of UNITS) {
    if (abs >= unit.size) {
      return unit;
    }
  }
  return { suffix: "B", size: 1 };
}

function formatInUnit(n: number, unit: ByteUnit): string {
  if (unit.suffix === "B") {
    return String(Math.round(n));
  }
  return formatScaled(n / unit.size);
}

/** Compact 1024-based sizes: 48M, 6.97G, 1.01T. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) {
    return "0B";
  }
  const unit = pickUnit(n);
  return `${formatInUnit(n, unit)}${unit.suffix}`;
}

/** Same unit on both sides: 48/512M, 6.97/8G. Omits the limit when missing. */
export function formatBytesPair(used: number, total: number | null): string {
  const safeUsed = Number.isFinite(used) && used > 0 ? used : 0;
  if (total == null || !Number.isFinite(total) || total <= 0) {
    return formatBytes(safeUsed);
  }
  const unit = pickUnit(Math.max(safeUsed, total));
  return `${formatInUnit(safeUsed, unit)}/${formatInUnit(total, unit)}${unit.suffix}`;
}

export function formatByteRate(n: number): string {
  return `${formatBytes(n)}/s`;
}

export function formatCpuPercent(cpu: number): string {
  if (!Number.isFinite(cpu) || cpu < 0.05) {
    return "0%";
  }
  if (cpu < 10) {
    return `${trimZeros(cpu.toFixed(1))}%`;
  }
  return `${Math.round(cpu)}%`;
}
