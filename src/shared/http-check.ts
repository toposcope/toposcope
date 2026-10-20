/**
 * An HTTP(S) monitor (#178): what it calls, and the conditions a run must pass, one a line.
 * Shared by the server, which judges each run, and the editor (18r), which judges the last
 * response as lines are picked from it. The lines are what is stored.
 */

export const httpMethods = ["GET", "HEAD", "POST"] as const;
export type HttpMethod = (typeof httpMethods)[number];

/** A run gives up after 10s. */
export const httpTimeoutMs = 10_000;

/** How often it runs: every 30s up to every 1h. */
export const httpEveryIds = ["30s", "1m", "5m", "15m", "30m", "1h"] as const;
export const minHttpEveryMs = 30_000;
export const maxHttpEveryMs = 60 * 60_000;
export const defaultHttpEvery = "30s";

/** Failed runs in a row before it opens. */
export const defaultFailAfter = 2;
export const maxFailAfter = 10;

export const maxConditionLines = 20;
export const maxConditionLine = 300;
export const maxHttpHeaders = 20;
export const maxHttpUrl = 2_000;
export const maxHttpBody = 10_000;
/** What a condition reads of a body, and what a row or the editor is shown. */
export const maxReadBody = 1_000_000;

export type CompareOp = "==" | "!=" | "<" | "<=" | ">" | ">=";
export type JsonScalar = string | number | boolean | null;
export type PathStep = string | number;

export type Condition =
  | { what: "status"; op: CompareOp; value: number }
  | { what: "status-in"; from: number; to: number }
  | { what: "time"; op: "<" | "<=" | ">" | ">="; ms: number }
  | { what: "body"; text: string }
  | { what: "json"; path: PathStep[]; op: CompareOp; value: JsonScalar }
  | { what: "header"; name: string; text: string }
  | { what: "cert"; op: ">" | ">="; ms: number };

export type ConditionLevel = "fail" | "warn";

/** One stored line: its text as written (without the level), whether it fails or warns, and what it reads. */
export type ConditionLine = { text: string; level: ConditionLevel; cond: Condition };

const dayMs = 24 * 60 * 60_000;
const hourMs = 60 * 60_000;

/** "30s" → 30000; null when it is not 30s … 1h. */
export function parseHttpEvery(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const m = /^(\d+)(s|m|h)$/.exec(value.trim());
  if (!m) {
    return null;
  }
  const ms = Number(m[1]) * (m[2] === "s" ? 1000 : m[2] === "m" ? 60_000 : hourMs);
  return ms >= minHttpEveryMs && ms <= maxHttpEveryMs ? ms : null;
}

/** 30000 → "30s", 300000 → "5m", 3600000 → "1h". */
export function formatHttpEvery(ms: number): string {
  if (ms % hourMs === 0) {
    return `${ms / hourMs}h`;
  }
  if (ms % 60_000 === 0) {
    return `${ms / 60_000}m`;
  }
  return `${Math.round(ms / 1000)}s`;
}

/** A URL a monitor may call: http or https, with a host. */
export function httpUrlProblem(raw: string): string | null {
  const url = raw.trim();
  if (!url) {
    return "url is required";
  }
  if (url.length > maxHttpUrl) {
    return `url is longer than ${maxHttpUrl} characters`;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "url must be an http(s) URL";
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
    return "url must be an http(s) URL";
  }
  if (parsed.username || parsed.password) {
    return "url must not carry a user or password; send an Authorization header";
  }
  return null;
}

const headerNameRe = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Set by the request itself, so a monitor cannot send its own. */
const ownHeaders = new Set(["host", "content-length", "transfer-encoding", "connection", "accept-encoding"]);

/** A request header a monitor may send: a token for a name, one line for a value. */
export function httpHeaderProblem(name: string, value: string): string | null {
  if (!headerNameRe.test(name)) {
    return `header ${JSON.stringify(name)} is not a header name`;
  }
  if (ownHeaders.has(name.toLowerCase())) {
    return `header ${name} is set by the request itself`;
  }
  if (/[\r\n\0]/.test(value)) {
    return `header ${name} must be one line`;
  }
  if (value.length > 4_000) {
    return `header ${name} is longer than 4000 characters`;
  }
  return null;
}

/**
 * The restricted JSONPath VISION locks for probes: `$`, then `.key`, `["key"]` or `[0]`.
 * No filters, wildcards, recursion or scripts.
 */
export function parseJsonPath(text: string): PathStep[] | null {
  const read = readPath(text);
  return read && read.end === text.length ? read.steps : null;
}

/** A path at the start of `text`, and where it ends. */
function readPath(text: string): { steps: PathStep[]; end: number } | null {
  if (!text.startsWith("$")) {
    return null;
  }
  const steps: PathStep[] = [];
  let i = 1;
  while (i < text.length && text[i] !== " " && !/^(==|!=|<|>)/.test(text.slice(i))) {
    const rest = text.slice(i);
    const key = /^\.([A-Za-z_$][\w$-]*)/.exec(rest);
    if (key) {
      steps.push(key[1]!);
      i += key[0].length;
      continue;
    }
    const index = /^\[(0|[1-9]\d{0,8})\]/.exec(rest);
    if (index) {
      steps.push(Number(index[1]));
      i += index[0].length;
      continue;
    }
    const quoted = /^\[("(?:[^"\\]|\\.)*")\]/.exec(rest);
    if (quoted) {
      try {
        steps.push(JSON.parse(quoted[1]!) as string);
      } catch {
        return null;
      }
      i += quoted[0].length;
      continue;
    }
    return null;
  }
  return { steps, end: i };
}

/** A path as a line writes it: `$.queue.depth`, `$.items[0]`, `$["a b"]`. */
export function formatJsonPath(steps: readonly PathStep[]): string {
  let out = "$";
  for (const step of steps) {
    if (typeof step === "number") {
      out += `[${step}]`;
    } else if (/^[A-Za-z_$][\w$-]*$/.test(step)) {
      out += `.${step}`;
    } else {
      out += `[${JSON.stringify(step)}]`;
    }
  }
  return out;
}

/** A value as a line writes it: strings quoted, the rest as JSON. */
export function formatJsonScalar(value: JsonScalar): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

const opRe = "(==|!=|<=|>=|<|>)";

function parseScalar(raw: string): JsonScalar | undefined {
  const text = raw.trim();
  if (!text) {
    return undefined;
  }
  if (text.startsWith('"')) {
    try {
      const v = JSON.parse(text) as unknown;
      return typeof v === "string" ? v : undefined;
    } catch {
      return undefined;
    }
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null") return null;
  if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(text)) {
    return Number(text);
  }
  // A bare word reads as a string: `$.status == UP`.
  return /^[^\s"]+$/.test(text) ? text : undefined;
}

function parseText(raw: string): string | undefined {
  const text = raw.trim();
  if (!text) {
    return undefined;
  }
  if (text.startsWith('"')) {
    try {
      const v = JSON.parse(text) as unknown;
      return typeof v === "string" && v.length > 0 ? v : undefined;
    } catch {
      return undefined;
    }
  }
  return text;
}

function parseMs(raw: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s)?$/.exec(raw.trim());
  if (!m) {
    return null;
  }
  const n = Number(m[1]);
  return m[2] === "s" ? Math.round(n * 1000) : Math.round(n);
}

function parseSpan(raw: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(d|h)$/.exec(raw.trim());
  if (!m) {
    return null;
  }
  return Number(m[1]) * (m[2] === "d" ? dayMs : hourMs);
}

function parseCondition(text: string): Condition | string {
  let m = /^status\s+in\s+(\d{3})\s*\.\.\s*(\d{3})$/i.exec(text);
  if (m) {
    const from = Number(m[1]);
    const to = Number(m[2]);
    return from <= to ? { what: "status-in", from, to } : "status in needs a low..high range";
  }
  m = new RegExp(`^status\\s*${opRe}\\s*(\\d{3})$`, "i").exec(text);
  if (m) {
    return { what: "status", op: m[1] as CompareOp, value: Number(m[2]) };
  }
  m = /^time\s*(<=|>=|<|>)\s*(.+)$/i.exec(text);
  if (m) {
    const ms = parseMs(m[2]!);
    return ms !== null && ms > 0
      ? { what: "time", op: m[1] as "<" | "<=" | ">" | ">=", ms }
      : "time needs a duration: time < 300ms";
  }
  m = /^body\s+contains\s+(.+)$/i.exec(text);
  if (m) {
    const t = parseText(m[1]!);
    return t !== undefined ? { what: "body", text: t } : 'body contains needs text: body contains "ok"';
  }
  m = /^header\s+([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s+contains\s+(.+)$/i.exec(text);
  if (m) {
    const t = parseText(m[2]!);
    return t !== undefined
      ? { what: "header", name: m[1]!.toLowerCase(), text: t }
      : "header contains needs text: header content-type contains json";
  }
  m = /^cert\s*(>=|>)\s*(.+)$/i.exec(text);
  if (m) {
    const ms = parseSpan(m[2]!);
    return ms !== null && ms > 0 ? { what: "cert", op: m[1] as ">" | ">=", ms } : "cert needs days left: cert > 14d";
  }
  if (text.startsWith("$")) {
    const read = readPath(text);
    if (!read) {
      return "a path is $.a.b[0]: no filters, wildcards or scripts";
    }
    const at = new RegExp(`^\\s*${opRe}\\s*(.+)$`).exec(text.slice(read.end));
    if (!at) {
      return 'a JSON line compares: $.db == "ok"';
    }
    const path = read.steps;
    const op = at[1] as CompareOp;
    const value = parseScalar(at[2]!);
    if (value === undefined) {
      return 'a JSON value is a number, "text", true, false or null';
    }
    if ((op === "<" || op === "<=" || op === ">" || op === ">=") && typeof value !== "number") {
      return `${op} compares a number`;
    }
    return { what: "json", path, op, value };
  }
  return 'not a condition: status == 200, time < 300ms, body contains "ok", $.db == "ok", header … contains …, cert > 14d';
}

/** The text a line keeps for a condition, written one way. */
export function formatCondition(c: Condition): string {
  switch (c.what) {
    case "status":
      return `status ${c.op} ${c.value}`;
    case "status-in":
      return `status in ${c.from}..${c.to}`;
    case "time":
      return `time ${c.op} ${c.ms}ms`;
    case "body":
      return `body contains ${JSON.stringify(c.text)}`;
    case "json":
      return `${formatJsonPath(c.path)} ${c.op} ${formatJsonScalar(c.value)}`;
    case "header":
      return `header ${c.name} contains ${/^[^\s"]+$/.test(c.text) ? c.text : JSON.stringify(c.text)}`;
    case "cert": {
      const days = c.ms / dayMs;
      return `cert ${c.op} ${Number.isInteger(days) ? `${days}d` : `${c.ms / hourMs}h`}`;
    }
  }
}

/** One line: its condition, and `warn` at its end when it warns instead of failing. */
export function parseConditionLine(raw: string): ConditionLine | { error: string } {
  const text = raw.trim();
  if (text.length > maxConditionLine) {
    return { error: `longer than ${maxConditionLine} characters` };
  }
  const warn = /^(.*\S)\s+warn$/i.exec(text);
  if (warn) {
    const cond = parseCondition(warn[1]!);
    if (typeof cond !== "string") {
      return { text: warn[1]!, level: "warn", cond };
    }
  }
  const failed = /^(.*\S)\s+fail$/i.exec(text);
  const body = failed && typeof parseCondition(failed[1]!) !== "string" ? failed[1]! : text;
  const cond = parseCondition(body);
  return typeof cond === "string" ? { error: cond } : { text: body, level: "fail", cond };
}

/** Every line, or the first that does not read, by its number. Blank lines are skipped. */
export function parseConditions(text: string): ConditionLine[] | { error: string; line: number } {
  const out: ConditionLine[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.trim()) {
      continue;
    }
    const line = parseConditionLine(lines[i]!);
    if ("error" in line) {
      return { error: `line ${i + 1}: ${line.error}`, line: i + 1 };
    }
    out.push(line);
  }
  if (out.length > maxConditionLines) {
    return { error: `at most ${maxConditionLines} conditions`, line: maxConditionLines + 1 };
  }
  return out;
}

/** The lines as stored, a warn line marked at its end (18r: `time < 300ms   warn`). */
export function formatConditions(lines: readonly Pick<ConditionLine, "text" | "level">[]): string {
  return lines.map((l) => (l.level === "warn" ? `${l.text}   warn` : l.text)).join("\n");
}

/** What a run saw, as the conditions read it. */
export type HttpSeen = {
  status: number;
  headers: ReadonlyArray<readonly [string, string]>;
  body: string;
  durationMs: number;
  https: boolean;
  /** When the certificate stops being valid, ISO; null over http. */
  certValidTo: string | null;
};

/** `pass` is null when there was no response to read. */
export type LineResult = { pass: boolean | null; got: string; why: string | null };

export type HttpResult = "ok" | "warn" | "fail";

export type Verdict = {
  result: HttpResult;
  lines: LineResult[];
  /** The line that decided it, when one did. */
  line: string | null;
  /** Why it is not ok, in words: `412ms is over 300ms`, `connect ECONNREFUSED`. */
  why: string | null;
};

function compare(a: number, op: CompareOp, b: number): boolean {
  switch (op) {
    case "==":
      return a === b;
    case "!=":
      return a !== b;
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
  }
}

const opWords: Record<CompareOp, string> = {
  "==": "",
  "!=": "not ",
  "<": "under ",
  "<=": "at most ",
  ">": "over ",
  ">=": "at least ",
};

/** "3 days", "5 hours", "expired". */
export function formatCertLeft(ms: number): string {
  if (ms <= 0) {
    return "expired";
  }
  if (ms >= dayMs) {
    const d = Math.floor(ms / dayMs);
    return `${d} day${d === 1 ? "" : "s"}`;
  }
  const h = Math.max(1, Math.floor(ms / hourMs));
  return `${h} hour${h === 1 ? "" : "s"}`;
}

/** "61d", "5h": a certificate's time left, short. */
export function formatCertShort(ms: number): string {
  if (ms <= 0) {
    return "expired";
  }
  return ms >= dayMs ? `${Math.floor(ms / dayMs)}d` : `${Math.max(1, Math.floor(ms / hourMs))}h`;
}

function short(text: string, max = 40): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The value at a path, or undefined when the body is not JSON or it is not there. */
export function readJsonPath(doc: unknown, path: readonly PathStep[]): unknown {
  let at: unknown = doc;
  for (const step of path) {
    if (typeof step === "number") {
      if (!Array.isArray(at) || step >= at.length) {
        return undefined;
      }
      at = at[step];
    } else {
      if (!at || typeof at !== "object" || Array.isArray(at) || !Object.hasOwn(at, step)) {
        return undefined;
      }
      at = (at as Record<string, unknown>)[step];
    }
  }
  return at;
}

function shown(value: unknown): string {
  if (typeof value === "string") {
    return short(JSON.stringify(value));
  }
  return short(JSON.stringify(value) ?? String(value));
}

function headerValue(headers: HttpSeen["headers"], name: string): string | null {
  const values = headers.filter(([k]) => k.toLowerCase() === name).map(([, v]) => v);
  return values.length > 0 ? values.join(", ") : null;
}

function judgeJson(c: Extract<Condition, { what: "json" }>, doc: unknown, isJson: boolean): LineResult {
  const path = formatJsonPath(c.path);
  if (!isJson) {
    return { pass: false, got: "not JSON", why: "the body is not JSON" };
  }
  const value = readJsonPath(doc, c.path);
  if (value === undefined) {
    return { pass: false, got: "missing", why: `${path} is missing` };
  }
  const got = shown(value);
  if (c.op === "==" || c.op === "!=") {
    let same: boolean;
    if (typeof c.value === "number") {
      const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
      same = n === c.value;
    } else if (typeof c.value === "string") {
      same =
        typeof value === "string"
          ? value === c.value
          : (typeof value === "number" || typeof value === "boolean") && String(value) === c.value;
    } else {
      same = value === c.value;
    }
    const pass = c.op === "==" ? same : !same;
    return {
      pass,
      got,
      why: pass ? null : c.op === "==" ? `${path} is ${got}, not ${formatJsonScalar(c.value)}` : `${path} is ${got}`,
    };
  }
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(n)) {
    return { pass: false, got, why: `${path} is ${got}, not a number` };
  }
  const pass = compare(n, c.op, c.value as number);
  return { pass, got, why: pass ? null : `${path} is ${got}, not ${opWords[c.op]}${c.value}` };
}

/** One line against what a run saw. */
export function judgeLine(c: Condition, seen: HttpSeen, nowMs: number, doc: { value: unknown; isJson: boolean }): LineResult {
  switch (c.what) {
    case "status": {
      const pass = compare(seen.status, c.op, c.value);
      return {
        pass,
        got: String(seen.status),
        why: pass ? null : `status is ${seen.status}, not ${opWords[c.op]}${c.value}`,
      };
    }
    case "status-in": {
      const pass = seen.status >= c.from && seen.status <= c.to;
      return { pass, got: String(seen.status), why: pass ? null : `status is ${seen.status}, not in ${c.from}..${c.to}` };
    }
    case "time": {
      const ms = Math.round(seen.durationMs);
      const pass = compare(ms, c.op, c.ms);
      const word = c.op === "<" || c.op === "<=" ? "over" : "under";
      return { pass, got: `${ms}ms`, why: pass ? null : `${ms}ms is ${word} ${c.ms}ms` };
    }
    case "body": {
      const pass = seen.body.includes(c.text);
      return {
        pass,
        got: pass ? "found" : "not found",
        why: pass ? null : `the body has no ${short(JSON.stringify(c.text))}`,
      };
    }
    case "json":
      return judgeJson(c, doc.value, doc.isJson);
    case "header": {
      const value = headerValue(seen.headers, c.name);
      if (value === null) {
        return { pass: false, got: "missing", why: `no ${c.name} header` };
      }
      const pass = value.toLowerCase().includes(c.text.toLowerCase());
      return { pass, got: short(value), why: pass ? null : `${c.name} is ${short(value)}` };
    }
    case "cert": {
      if (!seen.https || !seen.certValidTo) {
        return { pass: false, got: "no certificate", why: "no certificate over http" };
      }
      const left = Date.parse(seen.certValidTo) - nowMs;
      const pass = c.op === ">" ? left > c.ms : left >= c.ms;
      return {
        pass,
        got: formatCertShort(left),
        why: pass ? null : left <= 0 ? "the certificate has expired" : `certificate expires in ${formatCertLeft(left)}`,
      };
    }
  }
}

function parseDoc(body: string): { value: unknown; isJson: boolean } {
  const text = body.trim();
  if (!text || (text[0] !== "{" && text[0] !== "[")) {
    return { value: undefined, isJson: false };
  }
  try {
    return { value: JSON.parse(text) as unknown, isJson: true };
  } catch {
    return { value: undefined, isJson: false };
  }
}

/** A 3xx with somewhere to go: never followed, so the run fails. */
export function redirectTarget(seen: Pick<HttpSeen, "status" | "headers">, url: string): string | null {
  if (![301, 302, 303, 307, 308].includes(seen.status)) {
    return null;
  }
  const location = headerValue(seen.headers, "location");
  if (!location) {
    return null;
  }
  try {
    return new URL(location, url).toString();
  } catch {
    return location;
  }
}

/**
 * A run's result. No response is a fail with its error. A redirect is a fail, not followed.
 * With no lines, any 2xx passes. Otherwise a fail line that does not hold fails it, a warn line
 * that does not hold warns, and when every line holds it is ok.
 */
export function judgeRun(
  lines: readonly ConditionLine[],
  run: { seen: HttpSeen; url: string } | { error: string },
  nowMs: number,
): Verdict {
  if ("error" in run) {
    return {
      result: "fail",
      lines: lines.map(() => ({ pass: null, got: "—", why: null })),
      line: null,
      why: run.error,
    };
  }
  const doc = parseDoc(run.seen.body);
  const results = lines.map((l) => judgeLine(l.cond, run.seen, nowMs, doc));
  const redirect = redirectTarget(run.seen, run.url);
  if (redirect) {
    return { result: "fail", lines: results, line: null, why: `redirects to ${short(redirect, 120)}, not followed` };
  }
  if (lines.length === 0) {
    const ok = run.seen.status >= 200 && run.seen.status <= 299;
    return {
      result: ok ? "ok" : "fail",
      lines: results,
      line: null,
      why: ok ? null : `status is ${run.seen.status}, not 2xx`,
    };
  }
  for (const level of ["fail", "warn"] as const) {
    const i = lines.findIndex((l, k) => l.level === level && results[k]!.pass === false);
    if (i >= 0) {
      return { result: level, lines: results, line: lines[i]!.text, why: results[i]!.why };
    }
  }
  return { result: "ok", lines: results, line: null, why: null };
}

/** 18r's footer: "With these, the last response would warn: 412ms is over 300ms." */
export function verdictSentence(v: Pick<Verdict, "result" | "why">): { word: "pass" | "warn" | "fail"; rest: string } {
  const word = v.result === "ok" ? "pass" : v.result;
  return { word, rest: v.why ? `: ${v.why}.` : "." };
}
