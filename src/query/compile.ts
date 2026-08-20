import { isAttrIdent } from "../shared/attrs";
import { messageMatchesText, messageTokens } from "./message-tokens";

export const coreFields = ["level", "service", "host"] as const;
export type CoreField = (typeof coreFields)[number];

const core = new Set<string>(coreFields);

export function isCoreField(key: string): key is CoreField {
  return core.has(key);
}

export type QueryFault = {
  at: number;
  msg: string;
};

export type HighlightKind = "ws" | "key" | "val" | "op" | "str" | "glob" | "text";

export type HighlightToken = {
  t: HighlightKind;
  text: string;
  at: number;
};

export const cmpOps = [">=", "<=", ">", "<"] as const;
export type CmpOp = (typeof cmpOps)[number];

export type QueryNode =
  | { op: "and"; a: QueryNode; b: QueryNode }
  | { op: "or"; a: QueryNode; b: QueryNode }
  | { op: "not"; a: QueryNode }
  | { op: "kv"; key: string; value: string; glob: boolean }
  | { op: "cmp"; key: string; cmp: CmpOp; n: number }
  | { op: "text"; value: string; glob: boolean };

export type CompiledQuery = {
  ast: QueryNode | null;
  faults: QueryFault[];
};

export type SqlTable = "logs" | "minute" | "attr";

export type QueryShape = {
  hasMessage: boolean;
  attrKeys: string[];
  hasAttrNot: boolean;
  attrOrWithOther: boolean;
  hasAttrCmp: boolean;
};

export class QueryCompileError extends Error {
  readonly faults: QueryFault[];

  constructor(faults: QueryFault[]) {
    const first = faults[0];
    super(first ? `${faultCol(first.at)}: ${first.msg}` : "Invalid query");
    this.name = "QueryCompileError";
    this.faults = faults;
  }
}

export function faultCol(at: number): string {
  return `col ${at + 1}`;
}

const opWord = /^(and|or|not)$/i;

function isOpWord(word: string): boolean {
  return opWord.test(word);
}

export function compileQuery(q: string): CompiledQuery {
  const faults: QueryFault[] = [];
  const atoms = lex(q, faults);
  const ast = parse(atoms, faults);
  return { ast, faults };
}

export function requireCompiled(q: string): CompiledQuery {
  const compiled = compileQuery(q);
  if (compiled.faults.length > 0) {
    throw new QueryCompileError(compiled.faults);
  }
  return compiled;
}

export function tokenizeQuery(q: string): HighlightToken[] {
  return scan(q).tokens;
}

type Atom =
  | { k: "and" | "or" | "not" | "lparen" | "rparen"; at: number }
  | { k: "kv"; key: string; value: string; glob: boolean; at: number }
  | { k: "cmp"; key: string; cmp: CmpOp; n: number; at: number }
  | { k: "text"; value: string; glob: boolean; at: number };

type ScanResult = {
  tokens: HighlightToken[];
  atoms: Atom[];
};

function pushToken(
  tokens: HighlightToken[],
  t: HighlightKind,
  text: string,
  at: number,
): void {
  if (text.length === 0) {
    return;
  }
  tokens.push({ t, text, at });
}

function scan(q: string): ScanResult {
  const tokens: HighlightToken[] = [];
  const atoms: Atom[] = [];
  const faults: QueryFault[] = [];
  lexInto(q, tokens, atoms, faults);
  return { tokens, atoms };
}

function lex(q: string, faults: QueryFault[]): Atom[] {
  const tokens: HighlightToken[] = [];
  const atoms: Atom[] = [];
  lexInto(q, tokens, atoms, faults);
  return atoms;
}

function lexInto(
  q: string,
  tokens: HighlightToken[],
  atoms: Atom[],
  faults: QueryFault[],
): void {
  let i = 0;
  while (i < q.length) {
    const at = i;
    const ch = q[i];
    if (ch !== undefined && /\s/.test(ch)) {
      let j = i;
      while (j < q.length && /\s/.test(q[j] ?? "")) {
        j++;
      }
      pushToken(tokens, "ws", q.slice(i, j), at);
      i = j;
      continue;
    }
    if (ch === "(") {
      pushToken(tokens, "op", "(", at);
      atoms.push({ k: "lparen", at });
      i++;
      continue;
    }
    if (ch === ")") {
      pushToken(tokens, "op", ")", at);
      atoms.push({ k: "rparen", at });
      i++;
      continue;
    }
    if (ch === '"') {
      const { raw, inner, closed, next } = readQuote(q, i);
      pushToken(tokens, "str", raw, at);
      if (!closed) {
        faults.push({ at, msg: "unterminated phrase" });
      }
      atoms.push({ k: "text", value: inner, glob: false, at });
      i = next;
      continue;
    }
    if (ch === "-" && (i === 0 || /[\s(]/.test(q[i - 1] ?? ""))) {
      pushToken(tokens, "op", "-", at);
      atoms.push({ k: "not", at });
      i++;
      continue;
    }
    let j = i;
    while (j < q.length && !/[\s()"]/.test(q[j] ?? "")) {
      j++;
    }
    const word = q.slice(i, j);
    if (isOpWord(word)) {
      const k = word.toLowerCase() as "and" | "or" | "not";
      pushToken(tokens, "op", word, at);
      atoms.push({ k, at });
      i = j;
      continue;
    }
    const colon = word.indexOf(":");
    if (colon > 0) {
      const keyRaw = word.slice(0, colon);
      const key = keyRaw.toLowerCase();
      const after = word.slice(colon + 1);
      const keyOk = isCoreField(key) || isAttrIdent(key);
      if (!keyOk) {
        flagStars(word, at, faults, false);
        pushToken(tokens, "text", word, at);
        atoms.push({ k: "text", value: word, glob: false, at });
        i = j;
        continue;
      }
      pushToken(tokens, "key", `${keyRaw}:`, at);
      let value = after;
      let quoted = false;
      if (after.length === 0 && q[j] === '"') {
        const quote = readQuote(q, j);
        pushToken(tokens, "str", quote.raw, j);
        if (!quote.closed) {
          faults.push({ at: j, msg: "unterminated phrase" });
        }
        value = quote.inner;
        quoted = true;
        i = quote.next;
      } else {
        i = j;
      }
      if (value.length === 0) {
        faults.push({ at, msg: `${key}: has no value` });
        continue;
      }
      const valueAt = at + colon + 1;
      if (!quoted) {
        const parsed = splitCmp(value);
        if (parsed) {
          highlightCmp(tokens, parsed.cmp, parsed.rest, valueAt);
          pushCmpAtom(atoms, faults, key, parsed, at, valueAt);
          continue;
        }
        highlightValue(tokens, value, valueAt);
        flagStars(value, valueAt, faults, true);
      }
      const glob = !quoted && value.endsWith("*");
      atoms.push({
        k: "kv",
        key,
        value: glob ? value.slice(0, -1) : value,
        glob,
        at,
      });
      continue;
    }
    flagStars(word, at, faults, false);
    pushToken(tokens, "text", word, at);
    atoms.push({ k: "text", value: word, glob: false, at });
    i = j;
  }
}

function readQuote(
  q: string,
  start: number,
): { raw: string; inner: string; closed: boolean; next: number } {
  let j = start + 1;
  while (j < q.length && q[j] !== '"') {
    j++;
  }
  const closed = q[j] === '"';
  const end = closed ? j + 1 : j;
  return {
    raw: q.slice(start, end),
    inner: q.slice(start + 1, closed ? j : j),
    closed,
    next: end,
  };
}

function highlightValue(tokens: HighlightToken[], value: string, at: number): void {
  let k = 0;
  for (const part of value.split(/(\*)/)) {
    if (part === "*") {
      pushToken(tokens, "glob", "*", at + k);
    } else {
      pushToken(tokens, "val", part, at + k);
    }
    k += part.length;
  }
}

function highlightCmp(
  tokens: HighlightToken[],
  cmp: CmpOp,
  rest: string,
  at: number,
): void {
  pushToken(tokens, "op", cmp, at);
  highlightValue(tokens, rest, at + cmp.length);
}

/** `>=` / `<=` before `>` / `<`. Quoted values never take this path. */
function splitCmp(value: string): { cmp: CmpOp; rest: string } | null {
  for (const cmp of cmpOps) {
    if (value.startsWith(cmp)) {
      return { cmp, rest: value.slice(cmp.length) };
    }
  }
  return null;
}

const finiteDecimal = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

function isFiniteDecimal(raw: string): boolean {
  return finiteDecimal.test(raw) && Number.isFinite(Number(raw));
}

function pushCmpAtom(
  atoms: Atom[],
  faults: QueryFault[],
  key: string,
  parsed: { cmp: CmpOp; rest: string },
  at: number,
  valueAt: number,
): void {
  if (isCoreField(key)) {
    faults.push({ at, msg: `${key}: comparisons are for attrs` });
    return;
  }
  if (parsed.rest.includes("*")) {
    faults.push({ at: valueAt, msg: "cannot mix comparison and glob" });
    return;
  }
  if (parsed.rest.length === 0) {
    faults.push({ at, msg: `${key}: comparison needs a number` });
    return;
  }
  if (!isFiniteDecimal(parsed.rest)) {
    faults.push({ at: valueAt + parsed.cmp.length, msg: "not a finite decimal" });
    return;
  }
  atoms.push({ k: "cmp", key, cmp: parsed.cmp, n: Number(parsed.rest), at });
}

function flagStars(
  word: string,
  at: number,
  faults: QueryFault[],
  allowTrailing: boolean,
): void {
  const star = word.indexOf("*");
  if (star < 0) {
    return;
  }
  if (allowTrailing && star === word.length - 1) {
    return;
  }
  faults.push({ at: at + star, msg: "only a trailing * is supported" });
}

type ParseTok = {
  atoms: Atom[];
  i: number;
  faults: QueryFault[];
};

function peek(p: ParseTok): Atom | undefined {
  return p.atoms[p.i];
}

function parse(atoms: Atom[], faults: QueryFault[]): QueryNode | null {
  if (atoms.length === 0) {
    return null;
  }
  const p: ParseTok = { atoms, i: 0, faults };
  const node = parseOr(p);
  const extra = peek(p);
  if (extra) {
    if (extra.k === "rparen") {
      faults.push({ at: extra.at, msg: "unmatched )" });
    } else if (extra.k === "and" || extra.k === "or") {
      faults.push({ at: extra.at, msg: `expected term after ${extra.k}` });
    } else {
      faults.push({ at: extra.at, msg: "unexpected token" });
    }
  }
  return node;
}

function parseOr(p: ParseTok): QueryNode | null {
  let node = parseAnd(p);
  while (peek(p)?.k === "or") {
    const op = p.atoms[p.i];
    p.i++;
    const right = parseAnd(p);
    if (!right) {
      if (op) {
        p.faults.push({ at: op.at, msg: "expected term after or" });
      }
      break;
    }
    node = node ? { op: "or", a: node, b: right } : right;
  }
  return node;
}

function parseAnd(p: ParseTok): QueryNode | null {
  let node = parseUnary(p);
  const lead = peek(p);
  if (!node && lead && (lead.k === "and" || lead.k === "or")) {
    p.faults.push({ at: lead.at, msg: `expected term before ${lead.k}` });
  }
  while (p.i < p.atoms.length) {
    const next = peek(p);
    if (!next || next.k === "or" || next.k === "rparen") {
      break;
    }
    if (next.k === "and") {
      p.i++;
      const right = parseUnary(p);
      if (!right) {
        p.faults.push({ at: next.at, msg: "expected term after and" });
        break;
      }
      node = node ? { op: "and", a: node, b: right } : right;
      continue;
    }
    const right = parseUnary(p);
    if (!right) {
      break;
    }
    node = node ? { op: "and", a: node, b: right } : right;
  }
  return node;
}

function parseUnary(p: ParseTok): QueryNode | null {
  const next = peek(p);
  if (!next) {
    return null;
  }
  if (next.k === "not") {
    p.i++;
    const inner = parseUnary(p);
    if (!inner) {
      p.faults.push({ at: next.at, msg: "expected term after not" });
      return null;
    }
    return { op: "not", a: inner };
  }
  return parsePrimary(p);
}

function parsePrimary(p: ParseTok): QueryNode | null {
  const next = peek(p);
  if (!next) {
    return null;
  }
  if (next.k === "lparen") {
    p.i++;
    const inner = parseOr(p);
    const close = peek(p);
    if (close?.k === "rparen") {
      p.i++;
    } else {
      p.faults.push({ at: next.at, msg: "unmatched (" });
    }
    if (!inner) {
      p.faults.push({ at: next.at, msg: "expected term after (" });
    }
    return inner;
  }
  if (next.k === "rparen" || next.k === "and" || next.k === "or") {
    return null;
  }
  p.i++;
  if (next.k === "kv") {
    return { op: "kv", key: next.key, value: next.value, glob: next.glob };
  }
  if (next.k === "cmp") {
    return { op: "cmp", key: next.key, cmp: next.cmp, n: next.n };
  }
  if (next.k === "text") {
    return { op: "text", value: next.value, glob: next.glob };
  }
  return null;
}

export function omitField(compiled: CompiledQuery, field: string): CompiledQuery {
  return { ast: omitNode(compiled.ast, field), faults: compiled.faults };
}

function omitNode(node: QueryNode | null, field: string): QueryNode | null {
  if (!node) {
    return null;
  }
  switch (node.op) {
    case "kv":
    case "cmp":
      return node.key === field ? null : node;
    case "text":
      return node;
    case "not": {
      const inner = omitNode(node.a, field);
      return inner ? { op: "not", a: inner } : null;
    }
    case "and":
    case "or": {
      const a = omitNode(node.a, field);
      const b = omitNode(node.b, field);
      if (!a && !b) {
        return null;
      }
      if (!a) {
        return node.op === "or" ? null : b;
      }
      if (!b) {
        return node.op === "or" ? null : a;
      }
      return { op: node.op, a, b };
    }
    default: {
      const _exhaustive: never = node;
      return _exhaustive;
    }
  }
}

export function forEachAttrKv(
  compiled: CompiledQuery,
  visit: (node: Extract<QueryNode, { op: "kv" }>) => void,
): void {
  walk(compiled.ast, false, (node) => {
    if (node.op === "kv" && !isCoreField(node.key)) {
      visit(node);
    }
  });
}

export function analyzeQuery(compiled: CompiledQuery): QueryShape {
  const attrKeys = new Set<string>();
  let hasMessage = false;
  let hasAttrNot = false;
  let hasAttrCmp = false;
  walk(compiled.ast, false, (node, negated) => {
    if (node.op === "text") {
      hasMessage = true;
    }
    if (node.op === "cmp") {
      attrKeys.add(node.key);
      hasAttrCmp = true;
      if (negated) {
        hasAttrNot = true;
      }
    }
    if (node.op === "kv" && !isCoreField(node.key)) {
      attrKeys.add(node.key);
      if (negated) {
        hasAttrNot = true;
      }
    }
  });
  return {
    hasMessage,
    attrKeys: [...attrKeys],
    hasAttrNot,
    attrOrWithOther: mixesAttrOr(compiled.ast),
    hasAttrCmp,
  };
}

function walk(
  node: QueryNode | null,
  negated: boolean,
  visit: (node: QueryNode, negated: boolean) => void,
): void {
  if (!node) {
    return;
  }
  visit(node, negated);
  switch (node.op) {
    case "and":
    case "or":
      walk(node.a, negated, visit);
      walk(node.b, negated, visit);
      return;
    case "not":
      walk(node.a, !negated, visit);
      return;
    case "kv":
    case "cmp":
    case "text":
      return;
    default: {
      const _exhaustive: never = node;
      return _exhaustive;
    }
  }
}

function attrKeySet(node: QueryNode | null): Set<string> {
  const keys = new Set<string>();
  walk(node, false, (n) => {
    if ((n.op === "kv" || n.op === "cmp") && !isCoreField(n.key)) {
      keys.add(n.key);
    }
  });
  return keys;
}

function sameSingleton(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== 1 || b.size !== 1) {
    return false;
  }
  const [key] = a;
  return key !== undefined && b.has(key);
}

function mixesAttrOr(node: QueryNode | null): boolean {
  if (!node) {
    return false;
  }
  if (node.op === "or") {
    const left = attrKeySet(node.a);
    const right = attrKeySet(node.b);
    const ok =
      (left.size === 0 && right.size === 0) || sameSingleton(left, right);
    if (!ok) {
      return true;
    }
    return mixesAttrOr(node.a) || mixesAttrOr(node.b);
  }
  if (node.op === "and") {
    return mixesAttrOr(node.a) || mixesAttrOr(node.b);
  }
  if (node.op === "not") {
    return mixesAttrOr(node.a);
  }
  return false;
}

/** Positive (not negated) field equalities, for facet highlighting. */
export function activeEquals(compiled: CompiledQuery): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  collectEquals(compiled.ast, false, out);
  return out;
}

function collectEquals(
  node: QueryNode | null,
  negated: boolean,
  out: Record<string, string[]>,
): void {
  if (!node) {
    return;
  }
  if (node.op === "not") {
    collectEquals(node.a, !negated, out);
    return;
  }
  if (node.op === "and" || node.op === "or") {
    collectEquals(node.a, negated, out);
    collectEquals(node.b, negated, out);
    return;
  }
  if (node.op === "kv" && !negated && !node.glob) {
    const list = out[node.key] ?? [];
    if (!list.includes(node.value)) {
      list.push(node.value);
    }
    out[node.key] = list;
  }
}

export function emitQuerySql(
  compiled: CompiledQuery,
  params: Record<string, string>,
  table: SqlTable,
  attrKey?: string,
): string {
  if (compiled.faults.length > 0) {
    throw new QueryCompileError(compiled.faults);
  }
  return emitNode(compiled.ast, params, table, attrKey);
}

function emitNode(
  node: QueryNode | null,
  params: Record<string, string>,
  table: SqlTable,
  attrKey: string | undefined,
): string {
  if (!node) {
    return "";
  }
  switch (node.op) {
    case "and":
    case "or": {
      const a = emitNode(node.a, params, table, attrKey);
      const b = emitNode(node.b, params, table, attrKey);
      if (!a) {
        return b;
      }
      if (!b) {
        return a;
      }
      const join = node.op === "and" ? " AND " : " OR ";
      return `(${a}${join}${b})`;
    }
    case "not": {
      const inner = emitNode(node.a, params, table, attrKey);
      return inner ? `NOT (${inner})` : "";
    }
    case "kv":
      return emitKv(node, params, table, attrKey);
    case "cmp":
      return emitCmp(node, params, table);
    case "text":
      return emitText(node, params, table);
    default: {
      const _exhaustive: never = node;
      return _exhaustive;
    }
  }
}

function bind(
  params: Record<string, string>,
  value: string,
  type: "String" | "Float64" = "String",
): string {
  let i = 0;
  while (`qp${i}` in params) {
    i++;
  }
  const key = `qp${i}`;
  params[key] = value;
  return `{${key}:${type}}`;
}

function emitKv(
  node: Extract<QueryNode, { op: "kv" }>,
  params: Record<string, string>,
  table: SqlTable,
  attrKey: string | undefined,
): string {
  const value = bind(params, node.value);
  if (isCoreField(node.key)) {
    return node.glob
      ? `startsWith(${node.key}, ${value})`
      : `${node.key} = ${value}`;
  }
  if (table === "minute") {
    return "0";
  }
  if (table === "attr") {
    if (attrKey !== undefined && node.key !== attrKey) {
      return "0";
    }
    return node.glob ? `startsWith(value, ${value})` : `value = ${value}`;
  }
  const key = bind(params, node.key);
  const col = `attr_map[${key}]`;
  return node.glob ? `startsWith(${col}, ${value})` : `${col} = ${value}`;
}

function emitCmp(
  node: Extract<QueryNode, { op: "cmp" }>,
  params: Record<string, string>,
  table: SqlTable,
): string {
  if (table !== "logs") {
    return "0";
  }
  const key = bind(params, node.key);
  const n = bind(params, String(node.n), "Float64");
  return `ifNull(toFloat64OrNull(attr_map[${key}]) ${node.cmp} ${n}, 0)`;
}

function emitText(
  node: Extract<QueryNode, { op: "text" }>,
  params: Record<string, string>,
  table: SqlTable,
): string {
  if (table !== "logs") {
    return "0";
  }
  const tokens = messageTokens(node.value);
  if (tokens.length === 0) {
    return "0";
  }
  const refs = tokens.map((token) => bind(params, token));
  const hasEach = refs.map(
    (ref) => `hasToken(lowerUTF8(message), ${ref})`,
  );
  if (refs.length === 1) {
    return hasEach[0]!;
  }
  // 26.3 has no hasPhrase. hasToken prunes the text index; hasSubstr on
  // splitByNonAlpha is consecutive (hasAllTokens is any order).
  return `(${hasEach.join(" AND ")} AND hasSubstr(splitByNonAlpha(lowerUTF8(message)), [${refs.join(", ")}]))`;
}

export function matchNode(node: QueryNode | null, get: (key: string) => string): boolean {
  if (!node) {
    return true;
  }
  switch (node.op) {
    case "and":
      return matchNode(node.a, get) && matchNode(node.b, get);
    case "or":
      return matchNode(node.a, get) || matchNode(node.b, get);
    case "not":
      return !matchNode(node.a, get);
    case "kv": {
      const actual = get(node.key);
      if (node.glob) {
        return actual.startsWith(node.value);
      }
      return actual === node.value;
    }
    case "cmp":
      return matchCmp(parseStoredNumber(get(node.key)), node.cmp, node.n);
    case "text":
      return messageMatchesText(get("message"), node.value);
    default: {
      const _exhaustive: never = node;
      return _exhaustive;
    }
  }
}

/** Same idea as ClickHouse `toFloat64OrNull` on `attr_map` strings. */
function parseStoredNumber(raw: string): number | null {
  const t = raw.trim();
  if (t.length === 0) {
    return null;
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function matchCmp(actual: number | null, cmp: CmpOp, n: number): boolean {
  if (actual === null) {
    return false;
  }
  switch (cmp) {
    case ">":
      return actual > n;
    case ">=":
      return actual >= n;
    case "<":
      return actual < n;
    case "<=":
      return actual <= n;
    default: {
      const _exhaustive: never = cmp;
      return _exhaustive;
    }
  }
}
