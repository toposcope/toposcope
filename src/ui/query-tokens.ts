import { isAttrIdent } from "../shared/attrs";
import { fingerprintAttr } from "../shared/fingerprint-attr";
import { isCoreField } from "../query/compile";

const quotable = /[\s()"]/;

function isOrToken(token: string): boolean {
  return token.toLowerCase() === "or";
}

function tokenize(q: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < q.length) {
    const ch = q[i];
    if (ch !== undefined && /\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "(" || ch === ")") {
      out.push(ch);
      i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < q.length && q[j] !== '"') {
        j++;
      }
      out.push(q.slice(i, q[j] === '"' ? j + 1 : j));
      i = q[j] === '"' ? j + 1 : j;
      continue;
    }
    let j = i;
    while (j < q.length && !/[\s()"]/.test(q[j] ?? "")) {
      j++;
    }
    if (q[j] === '"' && q.slice(i, j).endsWith(":")) {
      const quoteStart = j;
      j++;
      while (j < q.length && q[j] !== '"') {
        j++;
      }
      out.push(q.slice(i, q[j] === '"' ? j + 1 : quoteStart));
      i = q[j] === '"' ? j + 1 : quoteStart;
      continue;
    }
    if (j > i) {
      out.push(q.slice(i, j));
    }
    i = j;
  }
  return out;
}

function encode(field: string, value: string): string {
  if (quotable.test(value)) {
    return `${field}:"${value.replace(/"/g, "")}"`;
  }
  return `${field}:${value}`;
}

function fieldPrefix(field: string): string {
  return `${field.toLowerCase()}:`;
}

function tokenField(token: string): string {
  if (token.startsWith('"') || token.startsWith("-")) {
    return "";
  }
  const colon = token.indexOf(":");
  return colon > 0 ? token.slice(0, colon + 1).toLowerCase() : "";
}

function tokenValue(token: string): string {
  const colon = token.indexOf(":");
  if (colon < 0) {
    return "";
  }
  const raw = token.slice(colon + 1);
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return raw.slice(1, -1);
  }
  return raw;
}

function hasTopLevelOr(tokens: string[]): boolean {
  let depth = 0;
  for (const token of tokens) {
    if (token === "(") {
      depth++;
      continue;
    }
    if (token === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && isOrToken(token)) {
      return true;
    }
  }
  return false;
}

function isAndOr(token: string): boolean {
  const word = token.toLowerCase();
  return word === "and" || word === "or";
}

function joinQuery(tokens: string[]): string {
  let out = "";
  for (const token of tokens) {
    if (!token) {
      continue;
    }
    if (out.length > 0 && token !== ")" && !out.endsWith("(")) {
      out += " ";
    }
    out += token;
  }
  return out;
}

function tidy(tokens: string[]): string[] {
  let prev = tokens;
  for (let n = 0; n < 8; n++) {
    const out: string[] = [];
    for (const token of prev) {
      if (
        isAndOr(token) &&
        (out.length === 0 ||
          isAndOr(out[out.length - 1] ?? "") ||
          out[out.length - 1] === "(")
      ) {
        continue;
      }
      if (token === ")" && out[out.length - 1] === "(") {
        out.pop();
        continue;
      }
      out.push(token);
    }
    while (out.length > 0 && isAndOr(out[out.length - 1] ?? "")) {
      out.pop();
    }
    const joined = out.join("\0");
    if (joined === prev.join("\0")) {
      return out;
    }
    prev = out;
  }
  return prev;
}

function isFieldToken(token: string, field: string): boolean {
  return tokenField(token) === fieldPrefix(field);
}

/** Values in a canonical facet set for `field`. Bare AND of the same key is not a set. */
export function facetValues(q: string, field: string): string[] {
  const tokens = tokenize(q);
  const prefix = fieldPrefix(field);
  let depth = 0;
  let groupStart = -1;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "(") {
      if (depth === 0) {
        groupStart = i;
      }
      depth++;
      continue;
    }
    if (token === ")") {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && groupStart >= 0) {
        const inner = tokens.slice(groupStart + 1, i);
        const orSet = pureOrSet(inner, field);
        if (orSet.length > 1) {
          return orSet;
        }
        groupStart = -1;
      }
    }
  }
  const top: string[] = [];
  depth = 0;
  for (const token of tokens) {
    if (token === "(") {
      depth++;
      continue;
    }
    if (token === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) {
      top.push(token);
    }
  }
  const fieldToks = top.filter((token) => tokenField(token) === prefix);
  if (fieldToks.length === 0) {
    return [];
  }
  if (fieldToks.length === 1) {
    return [tokenValue(fieldToks[0]!)];
  }
  if (
    top.some(isOrToken) &&
    top.every((token) => isOrToken(token) || tokenField(token) === prefix)
  ) {
    return fieldToks.map(tokenValue);
  }
  return [];
}

function pureOrSet(tokens: string[], field: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) {
      continue;
    }
    if (isFieldToken(token, field)) {
      values.push(tokenValue(token));
      continue;
    }
    if (isOrToken(token) && values.length > 0) {
      continue;
    }
    return [];
  }
  return values;
}

function stripField(tokens: string[], field: string): string[] {
  const prefix = fieldPrefix(field);
  const kept: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === "(") {
      let depth = 1;
      let j = i + 1;
      while (j < tokens.length && depth > 0) {
        if (tokens[j] === "(") {
          depth++;
        } else if (tokens[j] === ")") {
          depth--;
        }
        j++;
      }
      const inner = tokens.slice(i + 1, j - 1);
      if (pureOrSet(inner, field).length > 0) {
        i = j;
        continue;
      }
      kept.push("(");
      i++;
      continue;
    }
    if (token && tokenField(token) === prefix) {
      i++;
      continue;
    }
    kept.push(token!);
    i++;
  }
  return tidy(kept);
}

function setTokens(values: string[], field: string): string[] {
  if (values.length === 0) {
    return [];
  }
  if (values.length === 1) {
    return [encode(field, values[0]!)];
  }
  const inner: string[] = [];
  for (const value of values) {
    if (inner.length > 0) {
      inner.push("OR");
    }
    inner.push(encode(field, value));
  }
  return ["(", ...inner, ")"];
}

/** Replace the field's facet set. Empty drops it. */
export function setFieldValues(q: string, field: string, values: string[]): string {
  const unique: string[] = [];
  for (const value of values) {
    if (!unique.some((item) => item.toLowerCase() === value.toLowerCase())) {
      unique.push(value);
    }
  }
  const kept = stripField(tokenize(q), field);
  const next = setTokens(unique, field);
  if (next.length === 0) {
    return joinQuery(tidy(kept));
  }
  if (kept.length === 0) {
    return joinQuery(next);
  }
  const body = tidy(kept);
  if (hasTopLevelOr(body)) {
    return `(${joinQuery(body)}) ${joinQuery(next)}`;
  }
  return `${joinQuery(body)} ${joinQuery(next)}`;
}

export function formatFieldToken(field: string, value: string): string {
  return encode(field, value);
}

/** Facet checkboxes: canonical OR-sets only (bare AND of the same key is empty). */
export function activeFacetValues(
  q: string,
  fields: string[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const field of fields) {
    const values = facetValues(q, field);
    if (values.length > 0) {
      out[field] = values;
    }
  }
  return out;
}

export function hasFieldToken(q: string, field: string, value: string): boolean {
  const wanted = value.toLowerCase();
  return facetValues(q, field).some((item) => item.toLowerCase() === wanted);
}

export function hasExcludedFieldToken(
  q: string,
  field: string,
  value: string,
): boolean {
  const wanted = `-${encode(field, value)}`.toLowerCase();
  return tokenize(q).some((token) => token.toLowerCase() === wanted);
}

/** Cut Filter: one e1 value, or drop it if that is already the whole e1 set. */
export function toggleFingerprintCutFilter(q: string, hex: string): string {
  const current = facetValues(q, fingerprintAttr);
  if (
    current.length === 1 &&
    current[0]!.toLowerCase() === hex.toLowerCase()
  ) {
    return removeFieldToken(q, fingerprintAttr);
  }
  return setFieldToken(q, fingerprintAttr, hex);
}

/** Replace any existing `field:` set with one value, or append one. */
export function setFieldToken(q: string, field: string, value: string): string {
  return setFieldValues(q, field, [value]);
}

export function removeFieldToken(q: string, field: string): string {
  return setFieldValues(q, field, []);
}

/** Distinct `key:` names in q (core + attr), including negated tokens. */
export function queryFieldKeys(q: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tokenize(q)) {
    let token = raw;
    if (token.startsWith("-")) {
      token = token.slice(1);
    }
    const colon = token.indexOf(":");
    if (colon <= 0) {
      continue;
    }
    const key = token.slice(0, colon).toLowerCase();
    if (!isCoreField(key) && !isAttrIdent(key)) {
      continue;
    }
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(key);
  }
  return out;
}

export function stripSlotKeys(q: string, keys: string[]): string {
  return keys.reduce((acc, key) => removeFieldToken(acc, key), q);
}

/** Facet click: toggle membership in that field's OR set. */
export function toggleFieldToken(q: string, field: string, value: string): string {
  const current = facetValues(q, field);
  const wanted = value.toLowerCase();
  const next = current.some((item) => item.toLowerCase() === wanted)
    ? current.filter((item) => item.toLowerCase() !== wanted)
    : [...current, value];
  return setFieldValues(q, field, next);
}

/** Detail-panel `+`: add this value to the field's OR set. */
export function addFieldToken(q: string, field: string, value: string): string {
  const current = facetValues(q, field);
  if (current.some((item) => item.toLowerCase() === value.toLowerCase())) {
    return setFieldValues(q, field, current);
  }
  return setFieldValues(q, field, [...current, value]);
}

/** Append `-field:value`; drop a matching positive token. No-op if already excluded. */
export function excludeFieldToken(q: string, field: string, value: string): string {
  if (hasExcludedFieldToken(q, field, value)) {
    return q.trim();
  }
  const positive = encode(field, value);
  const next = `-${positive}`;
  const without = setFieldValues(q, field, facetValues(q, field).filter(
    (item) => item.toLowerCase() !== value.toLowerCase(),
  ));
  const tokens = tokenize(without);
  const body = joinQuery(tidy(tokens)).trim();
  if (!body) {
    return next;
  }
  return hasTopLevelOr(tokens) ? `(${body}) ${next}` : `${body} ${next}`;
}
