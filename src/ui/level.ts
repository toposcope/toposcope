import type { LogLevel } from "./types";

/** Stack order, quietest first, so error/fatal sit on top of the bar. */
export const levelOrder: LogLevel[] = ["debug", "info", "warn", "error", "fatal"];

export function levelVariant(
  level: LogLevel,
): "error" | "fatal" | "warn" | "info" | "debug" {
  return level;
}

/**
 * The level colours (sheet 45): `--level-*` in styles.css for classes, and these hexes where a
 * colour is drawn rather than classed (canvas, SVG export, inline borders). Keep the two in step.
 */
export const levelHex: Record<LogLevel, string> = {
  debug: "#52525b",
  info: "#0ea5e9",
  warn: "#f59e0b",
  error: "#ef4444",
  fatal: "#fca5a5",
};

/** Bar and rail fill per level. */
export const levelFill: Record<LogLevel, string> = {
  debug: "bg-level-debug",
  info: "bg-level-info",
  warn: "bg-level-warn",
  error: "bg-level-error",
  fatal: "bg-level-fatal",
};

export const levelRail: Record<LogLevel, string> = {
  debug: "bg-transparent",
  info: "bg-transparent",
  warn: "bg-level-warn/70",
  error: "bg-level-error/80",
  fatal: "bg-level-fatal",
};

/** A level written as text; debug's grey is a fill, so its text is muted. */
export const levelText: Record<LogLevel, string> = {
  debug: "text-muted-foreground",
  info: "text-info-fg",
  warn: "text-warn-fg",
  error: "text-danger-fg",
  fatal: "text-danger-fg",
};

export function isLoud(level: LogLevel): boolean {
  return level === "error" || level === "fatal";
}
