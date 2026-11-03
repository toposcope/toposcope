import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The lint ratchet (sheet 45, #439): values the design system replaced may not come back into
 * `src/ui/components`. Each file may hold at most its baseline count of each pattern; when a file
 * drops below it, lower the baseline (`DESIGN_LINT_UPDATE=1 bun test src/ui/design-lint.test.ts`)
 * so it cannot grow back. Chart palettes stay hex and are not scanned.
 */
const root = "src/ui/components";
const baselinePath = "src/ui/design-lint.baseline.json";
const exempt = new Set(["histogram-series.ts", "flame.ts", "waterfall.ts"]);

const palette = "red|amber|yellow|orange|emerald|green|sky|blue|zinc|neutral|gray|slate|stone|violet|purple|rose|pink|lime|teal|cyan|indigo|fuchsia";
const designRules: Record<string, { use: string; count: (src: string) => number }> = {
  "text-[Npx]": { use: "text-2xs … text-display", count: (s) => matches(s, /(?<![\w-])text-\[\d+(?:\.\d+)?px\]/g) },
  "[#hex] colour": { use: "surface, level and state tokens", count: (s) => matches(s, /(?<![\w-])[a-z-]+-\[#[0-9a-fA-F]{3,8}\]/g) },
  "raw palette class": {
    use: "text-danger-fg, bg-warn/20 …",
    count: (s) => matches(s, new RegExp(`(?<![\\w-])(?:text|bg|border|ring|fill|stroke|divide|outline|decoration|from|to|via)(?:-[trblxy])?-(?:${palette})-\\d{2,3}(?![\\w-])`, "g")),
  },
  "rounded-[Npx]": { use: "rounded-sm|md|lg|xl|full", count: (s) => matches(s, /(?<![\w-])rounded(?:-[a-z]{1,2})?-\[\d+(?:\.\d+)?px\]/g) },
  "<button with h-[…]": { use: "<Button size>", count: (s) => (s.match(/<button\b[^>]*?className=(?:"[^"]*|\{[^}]*)\bh-\[/g) ?? []).length },
};

function matches(src: string, re: RegExp): number {
  return (src.match(re) ?? []).length;
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) {
      return files(path);
    }
    return /\.tsx?$/.test(e.name) && !e.name.includes(".test.") && !exempt.has(e.name) ? [path] : [];
  });
}

function counts(): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const path of files(root).sort()) {
    const src = readFileSync(path, "utf8");
    for (const [rule, { count }] of Object.entries(designRules)) {
      const n = count(src);
      if (n > 0) {
        (out[path] ??= {})[rule] = n;
      }
    }
  }
  return out;
}

describe("design lint ratchet", () => {
  const now = counts();
  if (process.env.DESIGN_LINT_UPDATE === "1") {
    writeFileSync(baselinePath, `${JSON.stringify(now, null, 2)}\n`);
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Record<string, Record<string, number>>;

  test("no file adds a value the tokens replaced", () => {
    const grew: string[] = [];
    for (const [path, rules] of Object.entries(now)) {
      for (const [rule, n] of Object.entries(rules)) {
        const allowed = baseline[path]?.[rule] ?? 0;
        if (n > allowed) {
          grew.push(`${path}: ${rule} ${allowed} → ${n}; use ${designRules[rule]!.use}`);
        }
      }
    }
    expect(grew).toEqual([]);
  });

  test("the baseline only goes down", () => {
    const fell: string[] = [];
    for (const [path, rules] of Object.entries(baseline)) {
      for (const [rule, allowed] of Object.entries(rules)) {
        const n = now[path]?.[rule] ?? 0;
        if (n < allowed) {
          fell.push(`${path}: ${rule} ${allowed} → ${n}`);
        }
      }
    }
    // Lower it with DESIGN_LINT_UPDATE=1 so the drop cannot be undone.
    expect(fell).toEqual([]);
  });
});
