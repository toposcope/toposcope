import { compileQuery, isCoreField, type QueryNode } from "../query/compile";

/**
 * The kinds a link carries (#329, frames 33a–33c), as the browser shows them. The scope `q` runs on
 * each kind by the fields that kind has; this mirrors the server's rule in src/feed/kind-filter.ts
 * so a box can say why a kind would not be sent before the key is made.
 */
export const linkKinds = ["logs", "marks", "traces", "metrics", "profiles", "monitors"] as const;
export type LinkKind = (typeof linkKinds)[number];

export const kindTitle: Record<LinkKind, string> = {
  logs: "Logs",
  marks: "Marks",
  traces: "Traces",
  metrics: "Metrics",
  profiles: "Profiles",
  monitors: "Monitors",
};

/** What a kind's rows are called in a sentence: spans, points (33a, 33c). */
const rowNoun: Record<LinkKind, string> = {
  logs: "logs",
  marks: "marks",
  traces: "spans",
  metrics: "points",
  profiles: "profiles",
  monitors: "monitors",
};

/** `logs,marks,traces` (or a list) in the one order; unknown names dropped. */
export function kindsOf(raw: string | readonly string[] | null | undefined): LinkKind[] {
  const list = raw === null || raw === undefined ? ["logs", "marks"] : typeof raw === "string" ? raw.split(",").map((k) => k.trim()) : raw;
  return linkKinds.filter((k) => list.includes(k));
}

/**
 * Whether `kind` goes with scope `q`, and the words for its box. `field` is the part of `reason` to
 * set in mono (a field name), or null.
 */
export type KindSends = { kind: LinkKind; sends: true; words: string } | {
      kind: LinkKind;
      sends: false;
      reason: string;
      field: string | null;
      /** What the scope names that rules the kind out: a field, or "words in the message". */
      cause: string;
    };

type Fields = { map: boolean; other: boolean };
/** Spans and points read other keys from a map; a monitor has a service and a host only. */
const fieldsOf: Partial<Record<LinkKind, Fields>> = {
  traces: { map: true, other: true },
  metrics: { map: true, other: true },
  monitors: { map: false, other: false },
};

const textField = "words in the message";

/** The first field in `node` a kind with `f` cannot decide, in the order the server meets it. */
function blocked(node: QueryNode | null, f: Fields): string | null {
  if (!node) return null;
  switch (node.op) {
    case "and":
    case "or":
      return blocked(node.a, f) ?? blocked(node.b, f);
    case "not":
      return blocked(node.a, f);
    case "kv":
      if (node.key === "toposcope" || node.key === "service" || node.key === "host") return null;
      if (isCoreField(node.key)) return node.key; // level
      return f.other ? null : node.key;
    case "cmp":
      return f.map ? null : node.key;
    case "text":
      return textField;
  }
}

const sentWords: Record<LinkKind, { all: string; some: string }> = {
  logs: { all: "every row, message text included", some: "rows the scope matches, message text included" },
  marks: { all: "every mark", some: "every mark the scope does not rule out by service" },
  traces: { all: "every span, attributes as sent", some: "spans the scope matches by their attributes" },
  metrics: { all: "every point and bucket", some: "points and buckets the scope matches by their labels" },
  profiles: { all: "every profile", some: "the profiles of the spans that go" },
  monitors: { all: "every monitor result", some: "monitors by the service and host they check" },
};

function fieldReason(kind: LinkKind, field: string): string {
  if (kind === "monitors") return `the scope names ${field}; a monitor has a service and a host`;
  return `the scope names ${field}, which ${rowNoun[kind]} do not have`;
}

/** Each of the six kinds with scope `q`: sent, or not and why (33a). A q that does not compile sends all. */
export function kindsWithScope(q: string): KindSends[] {
  const ast = q.trim() === "" ? null : compileQuery(q).ast;
  const empty = ast === null;
  const spans = blocked(ast, fieldsOf.traces!);
  return linkKinds.map((kind): KindSends => {
    let field: string | null = null;
    if (kind === "profiles") {
      if (spans !== null) return { kind, sends: false, reason: "they go with their spans, and no spans go", field: null, cause: spans };
    } else {
      const f = fieldsOf[kind];
      field = f ? blocked(ast, f) : null;
    }
    if (field !== null) {
      return { kind, sends: false, reason: fieldReason(kind, field), field: field === textField ? null : field, cause: field };
    }
    return { kind, sends: true, words: empty ? sentWords[kind].all : sentWords[kind].some };
  });
}

/** "logs, marks and spans": a list in words. */
export function andList(words: readonly string[], last = "and"): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} ${last} ${words[words.length - 1]}`;
}

/**
 * One link or key in "What leaves this instance" (33c): who copies which kinds from us, and which
 * do not go and why. `pending` is a key not pasted yet, and `peer` then names the key.
 */
export function leavesWords(item: { peer: string; q: string; kinds: readonly LinkKind[]; pending: boolean }): string {
  const ticked = new Set(item.kinds);
  const lines = kindsWithScope(item.q);
  const going = lines.filter((l) => l.sends && ticked.has(l.kind)).map((l) => rowNoun[l.kind]);
  const scoped = lines.filter((l) => !l.sends && ticked.has(l.kind));
  const unticked = linkKinds.filter((k) => !ticked.has(k)).map((k) => rowNoun[k]);
  const what = going.length ? andList(going) : "nothing";
  const scope = item.q.trim() === "" ? "" : ` matching ${item.q.trim()}`;
  const head = item.pending
    ? `Once ${item.peer} is pasted, whoever pasted it will copy ${what}${going.length ? scope : ""} from us`
    : `${item.peer} copies ${what}${going.length ? scope : ""} from us`;
  const why: string[] = [];
  if (scoped.length) {
    // The fields the scope names that these kinds cannot decide, once each.
    const named = [...new Set(scoped.map((l) => (l.sends ? "" : l.cause)))].join(" and ");
    why.push(`no ${andList(scoped.map((l) => rowNoun[l.kind]), "or")}, because its scope names ${named}`);
  }
  if (unticked.length) {
    why.push(`no ${andList(unticked, "or")}, unticked`);
  }
  return `${head}${why.length ? `; ${why.join("; ")}` : ""}.`;
}

/** Bytes a day: 0 B, 2 KiB, 1.1 MiB, 11.3 GiB. */
export function bytesDay(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const text = i === 0 || v >= 100 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, "");
  return `${text} ${units[i]}`;
}
