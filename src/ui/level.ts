import type { LogLevel } from "./types";

/** Stack order, quietest first, so error/fatal sit on top of the bar. */
export const levelOrder: LogLevel[] = ["debug", "info", "warn", "error", "fatal"];

export function levelVariant(
  level: LogLevel,
): "error" | "fatal" | "warn" | "info" | "debug" {
  return level;
}

/** Bar and rail fill per level. */
export const levelFill: Record<LogLevel, string> = {
  debug: "bg-zinc-600",
  info: "bg-sky-500",
  warn: "bg-amber-500",
  error: "bg-red-500",
  fatal: "bg-red-300",
};

export const levelRail: Record<LogLevel, string> = {
  debug: "bg-transparent",
  info: "bg-transparent",
  warn: "bg-amber-500/70",
  error: "bg-red-500/80",
  fatal: "bg-red-300",
};

export function isLoud(level: LogLevel): boolean {
  return level === "error" || level === "fatal";
}
