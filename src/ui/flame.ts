import { formatTraceMs } from "./waterfall";
import type { ProfileStack } from "../shared/profile";

const namedPkg: Record<string, string> = {
  php: "#a78bfa",
  wordpress: "#34d399",
  mysql: "#fbbf24",
  plugin: "#fb7185",
  pcre: "#38bdf8",
  phpmailer: "#2dd4bf",
  net: "#c084fc",
  app: "#94a3b8",
};

const palette = [
  "#38bdf8",
  "#a78bfa",
  "#34d399",
  "#fbbf24",
  "#fb7185",
  "#94a3b8",
  "#c084fc",
  "#2dd4bf",
];

export type FlameFrame = {
  name: string;
  pkg: string;
  value: number;
  self: number;
  depth: number;
  x0: number;
};

type TreeNode = {
  name: string;
  value: number;
  children: Map<string, TreeNode>;
};

const pkgRules: Array<[RegExp, string]> = [
  [/^\{main\}|php::|require\(/i, "php"],
  [/wordpress|\bwp_|wp-|do_action|apply_filters|edit_post|sanitize_post/i, "wordpress"],
  [/mysqli|mysqlnd|\bmysql\b/i, "mysql"],
  [/pcre|preg_/i, "pcre"],
  [/phpmailer/i, "phpmailer"],
  [/stream_socket|fsockopen|^net\.|\/net\//i, "net"],
  [/plugin/i, "plugin"],
];

export function packageFromFrame(name: string): string {
  for (const [re, pkg] of pkgRules) {
    if (re.test(name)) {
      return pkg;
    }
  }
  const slash = name.replace(/\\/g, "/");
  if (slash.includes("/")) {
    const parts = slash.split("/").filter(Boolean);
    const dir = parts[parts.length - 2] ?? "";
    if (dir && dir !== "." && !dir.includes(".")) {
      return dir.toLowerCase();
    }
  }
  const token = name.split(/::|\./)[0]?.trim() ?? "";
  if (token && token.length < 24 && /^[A-Za-z_][\w-]*$/.test(token)) {
    return token.toLowerCase();
  }
  return "app";
}

export function packageColor(pkg: string): string {
  const named = namedPkg[pkg];
  if (named) {
    return named;
  }
  let hash = 0;
  for (let i = 0; i < pkg.length; i += 1) {
    hash = (hash * 31 + pkg.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length] ?? "#94a3b8";
}

export function formatProfileValue(value: number, unit: string): string {
  const u = unit.toLowerCase();
  if (u === "nanoseconds" || u === "ns") {
    return formatTraceMs(value / 1_000_000);
  }
  if (u === "microseconds" || u === "us" || u === "µs") {
    return formatTraceMs(value / 1_000);
  }
  if (u === "milliseconds" || u === "ms") {
    return formatTraceMs(value);
  }
  if (u === "seconds" || u === "s") {
    return formatTraceMs(value * 1_000);
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  if (Math.abs(rounded) >= 1_000_000) {
    return `${(rounded / 1_000_000).toFixed(2)}M`;
  }
  if (Math.abs(rounded) >= 1_000) {
    return `${(rounded / 1_000).toFixed(2)}K`;
  }
  return String(rounded);
}

export function formatProfileShare(value: number, total: number): string {
  if (total <= 0) {
    return "0%";
  }
  const p = (value / total) * 100;
  return `${p >= 10 ? Math.round(p) : Math.round(p * 10) / 10}%`;
}

function addStack(root: Map<string, TreeNode>, frames: string[], value: number): void {
  let level = root;
  for (const name of frames) {
    let node = level.get(name);
    if (!node) {
      node = { name, value: 0, children: new Map() };
      level.set(name, node);
    }
    node.value += value;
    level = node.children;
  }
}

function walk(
  nodes: Map<string, TreeNode>,
  depth: number,
  x0: number,
  out: FlameFrame[],
): void {
  let x = x0;
  for (const node of nodes.values()) {
    let childSum = 0;
    for (const child of node.children.values()) {
      childSum += child.value;
    }
    out.push({
      name: node.name,
      pkg: packageFromFrame(node.name),
      value: node.value,
      self: Math.max(0, node.value - childSum),
      depth,
      x0: x,
    });
    walk(node.children, depth + 1, x, out);
    x += node.value;
  }
}

export function layoutFlame(stacks: ProfileStack[]): {
  frames: FlameFrame[];
  total: number;
} {
  const roots = new Map<string, TreeNode>();
  for (const stack of stacks) {
    if (stack.frames.length === 0) {
      continue;
    }
    addStack(roots, stack.frames, stack.value);
  }
  const frames: FlameFrame[] = [];
  walk(roots, 0, 0, frames);
  const total = [...roots.values()].reduce((sum, node) => sum + node.value, 0);
  return { frames, total };
}

export function flamePinLit(frame: FlameFrame, pin: FlameFrame | null): boolean {
  if (!pin) {
    return true;
  }
  if (frame.depth >= pin.depth) {
    return frame.x0 >= pin.x0 && frame.x0 + frame.value <= pin.x0 + pin.value;
  }
  return frame.x0 <= pin.x0 && frame.x0 + frame.value >= pin.x0 + pin.value;
}
