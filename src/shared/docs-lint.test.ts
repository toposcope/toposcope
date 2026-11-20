import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

// The shape rules of CONTRIBUTING.md "Writing docs", so the docs stay readable on
// toposcope.io/docs and GitHub: short paragraphs and list items, a heading every few
// paragraphs, nothing below ###, and every relative link landing on a file and heading
// that exist. Code blocks and tables are not counted. docs/api.md is written by
// `bun run api-docs` and only has its links checked.
const LIMITS = { paragraph: 120, item: 80, section: 450 };

function docFiles(dir = "docs"): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return docFiles(path);
    return e.name.endsWith(".md") ? [path] : [];
  });
}
const docs = docFiles().filter((f) => !["docs/notepad.md", "docs/VISION.md"].includes(f));

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const stripCode = (md: string) => md.replace(/^```[\s\S]*?^```$/gm, "");

/** GitHub's heading ids: lower case, punctuation out, spaces to -, -1 on repeats. */
function headingIds(md: string): Set<string> {
  const seen = new Map<string, number>();
  const ids = new Set<string>();
  for (const m of stripCode(md).matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const text = (m[1] ?? "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[`*_]/g, (c) => (c === "_" ? "_" : ""));
    const base = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "").replace(/ /g, "-");
    let id = base;
    let n = seen.get(base) ?? 0;
    while (ids.has(id)) id = `${base}-${++n}`;
    seen.set(base, n);
    ids.add(id);
  }
  return ids;
}

interface Block { kind: "paragraph" | "item"; words: number; start: string }

/** Paragraphs and list items outside code and tables, and the words under each heading. */
function shape(md: string) {
  const blocks: Block[] = [];
  const sections: { heading: string; words: number }[] = [{ heading: "(top)", words: 0 }];
  let cur: string[] = [];
  let kind: Block["kind"] = "paragraph";
  const flush = () => {
    const text = cur.join(" ").trim();
    if (text) {
      const w = words(text);
      blocks.push({ kind, words: w, start: text.slice(0, 70) });
      sections[sections.length - 1]!.words += w;
    }
    cur = [];
  };
  for (const line of stripCode(md).split("\n")) {
    if (/^#{1,6}\s/.test(line)) {
      flush();
      sections.push({ heading: line.trim(), words: 0 });
    } else if (/^\s*\|/.test(line) || line.trim() === "" || /^<!--/.test(line)) {
      flush();
    } else if (/^\s*([-*+]|\d+\.)\s/.test(line)) {
      flush();
      kind = "item";
      cur.push(line.replace(/^\s*([-*+]|\d+\.)\s/, ""));
    } else {
      if (cur.length === 0) kind = /^\s{2,}/.test(line) ? kind : "paragraph";
      cur.push(line);
    }
  }
  flush();
  return { blocks, sections };
}

describe("docs shape (CONTRIBUTING.md, Writing docs)", () => {
  for (const file of docs.filter((f) => f !== "docs/api.md")) {
    const md = readFileSync(file, "utf8");
    const { blocks, sections } = shape(md);

    test(`${file}: paragraphs ≤ ${LIMITS.paragraph} words, list items ≤ ${LIMITS.item}`, () => {
      const long = blocks
        .filter((b) => b.words > (b.kind === "item" ? LIMITS.item : LIMITS.paragraph))
        .map((b) => `${b.kind} of ${b.words} words: "${b.start}…"`);
      expect(long).toEqual([]);
    });

    test(`${file}: a heading at least every ${LIMITS.section} words, none below ###`, () => {
      const long = sections.filter((s) => s.words > LIMITS.section).map((s) => `${s.words} words under ${s.heading}`);
      const deep = sections.filter((s) => /^#{4,}\s/.test(s.heading)).map((s) => s.heading);
      expect([...long, ...deep]).toEqual([]);
    });
  }
});

describe("docs links", () => {
  const ids = new Map<string, Set<string>>();
  const idsOf = (file: string) => {
    if (!ids.has(file)) ids.set(file, headingIds(readFileSync(file, "utf8")));
    return ids.get(file)!;
  };
  for (const file of docs) {
    test(`${file}: every relative link lands on a file and heading that exist`, () => {
      const broken: string[] = [];
      for (const m of stripCode(readFileSync(file, "utf8")).matchAll(/\]\(([^)\s]+)\)/g)) {
        const href = m[1] ?? "";
        if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
        const [path, hash] = href.split("#");
        const target = path ? normalize(join(dirname(file), decodeURIComponent(path))) : file;
        if (!existsSync(target)) {
          broken.push(`${href}: no ${target}`);
          continue;
        }
        if (hash && target.endsWith(".md") && !idsOf(target).has(hash)) broken.push(`${href}: no #${hash} in ${target}`);
      }
      expect(broken).toEqual([]);
    });
  }
});
