import {
  formatCondition,
  formatJsonPath,
  formatJsonScalar,
  httpHeaderProblem,
  maxHttpHeaders,
  parseConditionLine,
  type CheckKind,
  type ConditionLevel,
  type ConditionLine,
  type JsonScalar,
  type PathStep,
} from "../shared/http-check";

/**
 * The HTTP(S) editor (#178, frame 18r): conditions picked from the live response and stored as
 * lines. The lines are the source of truth; what is clicked writes a line, and every row reads
 * back from them.
 */

/** "api /health" from https://api.agental.dev/health: the first label of its host, and its path. */
export function nameFromUrl(raw: string): string {
  try {
    const url = new URL(raw.trim());
    // An address or a bare name is kept whole: 127.0.0.1:8080, localhost.
    const bare = /^[\d.]+$/.test(url.hostname) || url.hostname.includes(":") || !url.hostname.includes(".");
    const host = bare ? url.host : url.hostname.split(".")[0]!;
    const path = url.pathname === "/" ? "" : url.pathname;
    return `${host}${path ? ` ${path}` : ""}`.slice(0, 80);
  } catch {
    return "";
  }
}

export type EditorLine = {
  /** Which line of the stored text it is, from 0. */
  index: number;
  raw: string;
  line: ConditionLine | null;
  error: string | null;
};

/**
 * Each written line, read: a condition, or why it is not one. Blank lines are left out. `kind`
 * is whose lines they are: an HTTP(S) monitor's, or a TCP or certificate monitor's (#180).
 */
export function editorLines(text: string, kind: CheckKind = "http"): EditorLine[] {
  return text.split("\n").flatMap((raw, index): EditorLine[] => {
    if (!raw.trim()) {
      return [];
    }
    const read = parseConditionLine(raw, kind);
    return "error" in read
      ? [{ index, raw, line: null, error: read.error }]
      : [{ index, raw, line: read, error: null }];
  });
}

/** The good lines, in order: what a run is judged by. */
export function goodLines(text: string, kind: CheckKind = "http"): ConditionLine[] {
  return editorLines(text, kind).flatMap((l) => (l.line ? [l.line] : []));
}

function writeLine(line: Pick<ConditionLine, "text" | "level">): string {
  return line.level === "warn" ? `${line.text}   warn` : line.text;
}

function replaceAt(text: string, index: number, next: string | null): string {
  const lines = text.split("\n");
  if (next === null) {
    lines.splice(index, 1);
  } else {
    lines[index] = next;
  }
  return lines.join("\n").replace(/^\n+/, "");
}

/** A line's fail | warn toggle. */
export function setLineLevel(text: string, index: number, level: ConditionLevel, kind: CheckKind = "http"): string {
  const read = parseConditionLine(text.split("\n")[index] ?? "", kind);
  return "error" in read ? text : replaceAt(text, index, writeLine({ text: read.text, level }));
}

/** A line's ×. */
export function removeLine(text: string, index: number): string {
  return replaceAt(text, index, null);
}

/** A picked condition, as a new last line; a line already there is not written twice. */
export function addLine(text: string, line: string, kind: CheckKind = "http"): string {
  const read = parseConditionLine(line, kind);
  if ("error" in read) {
    return text;
  }
  const canonical = formatCondition(read.cond);
  if (goodLines(text, kind).some((l) => formatCondition(l.cond) === canonical)) {
    return text;
  }
  const body = text.replace(/\s+$/, "");
  return body ? `${body}\n${writeLine({ text: canonical, level: read.level })}` : writeLine({ text: canonical, level: read.level });
}

/** The first `time <` line and its limit, for the marker on the timing bar. */
export function timeLine(text: string, kind: CheckKind = "http"): { index: number; ms: number; level: ConditionLevel } | null {
  for (const l of editorLines(text, kind)) {
    if (l.line?.cond.what === "time" && (l.line.cond.op === "<" || l.line.cond.op === "<=")) {
      return { index: l.index, ms: l.line.cond.ms, level: l.line.level };
    }
  }
  return null;
}

/** The marker dragged: the `time <` line takes the new limit, keeping its level. */
export function setTimeLimit(text: string, ms: number, kind: CheckKind = "http"): string {
  const at = timeLine(text, kind);
  const limit = Math.max(10, Math.round(ms / 10) * 10);
  if (!at) {
    return addLine(text, `time < ${limit}ms`, kind);
  }
  return replaceAt(text, at.index, writeLine({ text: `time < ${limit}ms`, level: at.level }));
}

/** A limit to offer for a run of `total` ms: half again, rounded up to 50ms. */
export function offeredTimeLimit(total: number): number {
  return Math.max(50, Math.ceil((total * 1.5) / 50) * 50);
}

export type Timings = { dns: number; connect: number; tls: number | null; wait: number; body: number; total: number };

export type TimingSegment = { id: "dns" | "connect" | "starttls" | "tls" | "wait" | "body"; ms: number; frac: number };

export type TimingBar = { segments: TimingSegment[]; spanMs: number; marker: number | null };

/** Parts of a run as shares of a bar that spans the run or the limit, whichever is longer. `keep` is drawn even at 0ms. */
export function barOf(
  parts: Array<[TimingSegment["id"], number]>,
  totalMs: number,
  limitMs: number | null,
  keep: TimingSegment["id"] | null,
): TimingBar {
  const sum = parts.reduce((n, [, ms]) => n + Math.max(0, ms), 0);
  const total = Math.max(totalMs, sum, 1);
  const spanMs = limitMs !== null && limitMs > total ? limitMs * 1.1 : total;
  return {
    segments: parts
      .filter(([id, ms]) => ms > 0 || id === keep)
      .map(([id, ms]) => ({ id, ms, frac: Math.max(0, ms) / spanMs })),
    spanMs,
    marker: limitMs !== null ? Math.min(1, limitMs / spanMs) : null,
  };
}

/** The timing bar's parts as shares of the bar, which spans the run or the limit, whichever is longer. */
export function timingBar(t: Timings, limitMs: number | null): TimingBar {
  return barOf(
    [
      ["dns", t.dns],
      ["connect", t.connect],
      ["tls", t.tls ?? 0],
      ["wait", t.wait],
      ["body", t.body],
    ],
    t.total,
    limitMs,
    "wait",
  );
}

/** "dns 4 · connect 18 · tls 41 · wait 340 · body 9" (no tls over http). */
export function timingWords(t: Timings): string {
  const r = (n: number) => String(Math.round(n));
  return [
    `dns ${r(t.dns)}`,
    `connect ${r(t.connect)}`,
    ...(t.tls !== null ? [`tls ${r(t.tls)}`] : []),
    `wait ${r(t.wait)}`,
    `body ${r(t.body)}`,
  ].join(" · ");
}

/** "61 B", "2.4 KB", "1.1 MB". */
export function formatBytes(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** One row of the JSON body as 18r draws it: a key, a value, or a brace. */
export type JsonRow = {
  depth: number;
  key: string | null;
  /** Set on a value that can be picked. */
  path: PathStep[] | null;
  value: JsonScalar | undefined;
  /** `{`, `[`, `}`, `]`, `{}` or `[]` when the row opens, closes, or is an empty container. */
  brace: string | null;
  comma: boolean;
};

/** A JSON value as rows, at most `max` of them. */
export function jsonRows(doc: unknown, max = 400): JsonRow[] {
  const out: JsonRow[] = [];
  const walk = (value: unknown, path: PathStep[], key: string | null, depth: number, comma: boolean) => {
    if (out.length >= max) {
      return;
    }
    if (value !== null && typeof value === "object") {
      const entries: Array<[PathStep, unknown]> = Array.isArray(value)
        ? value.map((v, i) => [i, v])
        : Object.entries(value as Record<string, unknown>);
      const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
      if (entries.length === 0) {
        out.push({ depth, key, path: null, value: undefined, brace: `${open}${close}`, comma });
        return;
      }
      out.push({ depth, key, path: null, value: undefined, brace: open, comma: false });
      entries.forEach(([k, v], i) =>
        walk(v, [...path, k], Array.isArray(value) ? null : String(k), depth + 1, i < entries.length - 1),
      );
      out.push({ depth, key: null, path: null, value: undefined, brace: close, comma });
      return;
    }
    out.push({ depth, key, path, value: value as JsonScalar, brace: null, comma });
  };
  walk(doc, [], null, 0, false);
  return out;
}

/** What a picked value offers: `== value`, and for a number `<` and `>` too. */
export function offeredLines(path: PathStep[], value: JsonScalar): string[] {
  const p = formatJsonPath(path);
  const eq = `${p} == ${formatJsonScalar(value)}`;
  return typeof value === "number" ? [eq, `${p} < ${value}`, `${p} > ${value}`] : [eq];
}

/** A body line offered as `body contains "…"`: the line, trimmed, up to 40 characters. */
export function bodyContains(line: string): string | null {
  const text = line.trim().slice(0, 40).replace(/"/g, "");
  return text ? `body contains ${JSON.stringify(text)}` : null;
}

/** A response header offered as a line: its value up to a `;`. */
export function headerContains(name: string, value: string): string | null {
  const text = value.split(";")[0]!.trim().slice(0, 60).replace(/"/g, "");
  if (!text) {
    return null;
  }
  return `header ${name.toLowerCase()} contains ${/\s/.test(text) ? JSON.stringify(text) : text}`;
}

/** Shown for a stored header's value, which the browser is never sent (18v). */
export const keptValue = "••••••••••••";

/** A monitor's headers in the request box: `Name: value`, a stored one as `Name: ••••`. */
export function headersText(names: readonly string[]): string {
  return names.map((n) => `${n}: ${keptValue}`).join("\n");
}

/** The request box read back: name → value, or null to keep what is stored under that name. */
export function readHeadersText(
  text: string,
): { ok: true; headers: Record<string, string | null> } | { ok: false; error: string } {
  const out: Record<string, string | null> = {};
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length > maxHttpHeaders) {
    return { ok: false, error: `at most ${maxHttpHeaders} headers` };
  }
  for (const line of lines) {
    const at = line.indexOf(":");
    if (at <= 0) {
      return { ok: false, error: `${line.trim().slice(0, 40)}: a header is Name: value` };
    }
    const name = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (/^•+$/.test(value)) {
      out[name] = null;
      continue;
    }
    const problem = httpHeaderProblem(name, value);
    if (problem) {
      return { ok: false, error: problem };
    }
    out[name] = value;
  }
  return { ok: true, headers: out };
}

/** "ntfy.sh/agental-ops": where its calls go, short. */
export function webhookShort(url: string): string {
  try {
    const u = new URL(url.trim());
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url.trim();
  }
}
