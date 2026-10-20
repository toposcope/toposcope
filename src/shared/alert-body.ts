/**
 * An alert's body of its own (#108): text or JSON with `{{…}}` fill-ins. Shared by the server,
 * which fills and sends it, and the alert dialog, which lists the fill-ins and checks the JSON.
 */

export const alertBodyKinds = ["default", "text", "json"] as const;
export type AlertBodyKind = (typeof alertBodyKinds)[number];

/** Longest body kept; a push service's message is far shorter. */
export const maxAlertBodyLength = 8_000;

export type AlertFillIn = { name: string; about: string };

/** Frame 15e's list, for a threshold alert. */
export const thresholdFillIns: AlertFillIn[] = [
  { name: "alert.name", about: "the alert" },
  { name: "series", about: "what it reads" },
  { name: "value", about: "what it read" },
  { name: "threshold", about: "the threshold" },
  { name: "query", about: "the search" },
  { name: "fired_at", about: "ISO time" },
  { name: "link", about: "back to Toposcope" },
  { name: "state", about: "open, reminder, resolved" },
  { name: "opened_at", about: "ISO time" },
  { name: "resolved_at", about: "ISO time, once resolved" },
  { name: "duration", about: "open so far, or how long" },
  { name: "message", about: "the result that opened it" },
];

/** Frame 15f's list, for a new-fingerprints alert. */
export const firstSeenFillIns: AlertFillIn[] = [
  { name: "alert.name", about: "the alert" },
  { name: "query", about: "the search" },
  { name: "mark.kind", about: "deploy or flag" },
  { name: "mark.version", about: "the mark's title" },
  { name: "mark.at", about: "ISO time" },
  { name: "fingerprints.count", about: "new this call" },
  { name: "fingerprints.first", about: "type: message" },
  { name: "fingerprints", about: "up to 10; a list" },
  { name: "more", about: "how many past 10" },
  { name: "link", about: "the mark’s Fingerprints" },
];

export function alertFillIns(kind: "threshold" | "first_seen"): AlertFillIn[] {
  return kind === "first_seen" ? firstSeenFillIns : thresholdFillIns;
}

const fillInRe = /\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g;

/** `{{name}}` fill-ins that this kind of alert does not have. */
export function unknownFillIns(template: string, kind: "threshold" | "first_seen"): string[] {
  const known = new Set(alertFillIns(kind).map((f) => f.name));
  const out: string[] = [];
  for (const m of template.matchAll(fillInRe)) {
    const name = m[1]!;
    if (!known.has(name) && !out.includes(name)) {
      out.push(name);
    }
  }
  return out;
}

/** Fill a template. In a JSON body each value is escaped to sit inside a JSON string. */
export function fillAlertBody(
  template: string,
  values: Record<string, string>,
  kind: "text" | "json",
): string {
  return template.replace(fillInRe, (_, name: string) => {
    const value = values[name] ?? "";
    return kind === "json" ? JSON.stringify(value).slice(1, -1) : value;
  });
}

export type JsonBodyFault = {
  line: number;
  column: number;
  /** "a , is missing", "a value is expected", … */
  what: string;
  /** The text the fault comes after, as written, when that says where: `"[YOUR USER KEY]"`. */
  after: string | null;
};

/**
 * Where a JSON body stops being JSON, with fill-ins read as strings (they are filled escaped,
 * so they belong inside quotes). Null when it parses.
 */
export function checkJsonBody(template: string): JsonBodyFault | null {
  // Same length, so a fault's line and column are the template's own.
  const text = template.replace(fillInRe, (m) => "x".repeat(m.length));
  let i = 0;
  let lastValue: [number, number] | null = null;

  const fault = (what: string, at = i, after: [number, number] | null = null): never => {
    const before = text.slice(0, at);
    const line = before.split("\n").length;
    const column = at - before.lastIndexOf("\n");
    let quoted: string | null = null;
    if (after) {
      const raw = template.slice(after[0], after[1]);
      quoted = raw.length > 32 ? `${raw.slice(0, 31)}…` : raw;
    }
    throw { line, column, what, after: quoted } satisfies JsonBodyFault;
  };
  const ws = () => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };
  const value = (): void => {
    ws();
    const start = i;
    const ch = text[i];
    if (ch === undefined) {
      fault("the body ends where a value is expected");
    } else if (ch === "{") {
      object();
    } else if (ch === "[") {
      array();
    } else if (ch === '"') {
      string();
    } else if (ch === "-" || (ch >= "0" && ch <= "9")) {
      const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
      if (!m) fault("a number is not written right");
      i += m![0].length;
    } else if (text.startsWith("true", i)) {
      i += 4;
    } else if (text.startsWith("false", i)) {
      i += 5;
    } else if (text.startsWith("null", i)) {
      i += 4;
    } else {
      fault("a value is expected");
    }
    lastValue = [start, i];
  };
  const string = (): void => {
    const start = i;
    i++;
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === '"') {
        i++;
        return;
      }
      if (ch === "\n") {
        fault('a " is missing to close this string', start);
      }
      i++;
    }
    fault('a " is missing to close this string', start);
  };
  const object = (): void => {
    i++;
    ws();
    if (text[i] === "}") {
      i++;
      return;
    }
    for (;;) {
      ws();
      if (text[i] !== '"') {
        fault(text[i] === undefined ? "the body ends inside an object" : "a key in quotes is expected");
      }
      const keyStart = i;
      string();
      const key: [number, number] = [keyStart, i];
      ws();
      if (text[i] !== ":") {
        fault("a : is missing", i, key);
      }
      i++;
      value();
      const prev = lastValue;
      ws();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "}") {
        i++;
        return;
      }
      fault(text[i] === undefined ? "the body ends inside an object" : "a , is missing", i, prev);
    }
  };
  const array = (): void => {
    i++;
    ws();
    if (text[i] === "]") {
      i++;
      return;
    }
    for (;;) {
      value();
      const prev = lastValue;
      ws();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "]") {
        i++;
        return;
      }
      fault(text[i] === undefined ? "the body ends inside a list" : "a , is missing", i, prev);
    }
  };

  try {
    value();
    ws();
    if (i < text.length) {
      fault("there is more after the body's end");
    }
    return null;
  } catch (err) {
    if (err && typeof err === "object" && "line" in err) {
      return err as JsonBodyFault;
    }
    throw err;
  }
}

/** "Not JSON yet: line 4, column 3 — a , is missing after "[YOUR USER KEY]"." */
export function jsonBodyFaultText(f: JsonBodyFault): string {
  return `Not JSON yet: line ${f.line}, column ${f.column} — ${f.what}${f.after ? ` after ${f.after}` : ""}.`;
}

/** Why a resolved body cannot be saved, or null. Empty is fine: then it sends no resolved call. */
export function resolvedBodyProblem(
  bodyKind: AlertBodyKind,
  template: string,
  alertKind: "threshold" | "first_seen",
): string | null {
  if (!template.trim() || bodyKind === "default") {
    return null;
  }
  if (alertKind === "first_seen") {
    return "a new-fingerprints monitor does not resolve, so it has no resolved body";
  }
  const problem = alertBodyProblem(bodyKind, template, alertKind);
  return problem ? `the resolved body: ${problem}` : null;
}

/** Why a body cannot be saved, or null. */
export function alertBodyProblem(
  bodyKind: AlertBodyKind,
  template: string,
  alertKind: "threshold" | "first_seen",
): string | null {
  if (bodyKind === "default") {
    return null;
  }
  if (!template.trim()) {
    return "the body is empty";
  }
  if (template.length > maxAlertBodyLength) {
    return `the body is longer than ${maxAlertBodyLength} characters`;
  }
  const unknown = unknownFillIns(template, alertKind);
  if (unknown.length > 0) {
    return `{{${unknown[0]}}} is not a fill-in for this alert`;
  }
  if (bodyKind === "json") {
    const f = checkJsonBody(template);
    if (f) {
      return `${jsonBodyFaultText(f)} Fill-ins count as strings here, so check the quotes around them.`;
    }
  }
  return null;
}

/** What a body is sent as. */
export function alertBodyContentType(kind: AlertBodyKind): string {
  return kind === "text" ? "text/plain; charset=utf-8" : "application/json";
}

/** Prefilled when a resolved body is added. */
export function starterResolvedBody(bodyKind: "text" | "json"): string {
  return bodyKind === "text"
    ? "{{alert.name}} resolved after {{duration}}: {{series}} {{value}} < {{threshold}}\n{{link}}"
    : '{\n  "title": "{{alert.name}} resolved",\n  "message": "after {{duration}}: {{series}} {{value}} < {{threshold}}",\n  "url": "{{link}}"\n}';
}

/** Prefilled when Text or JSON is picked, so there is something to change. */
export function starterAlertBody(bodyKind: "text" | "json", alertKind: "threshold" | "first_seen"): string {
  if (alertKind === "first_seen") {
    return bodyKind === "text"
      ? "{{alert.name}}: {{fingerprints.count}} new after {{mark.kind}} {{mark.version}}\n{{fingerprints}}\n{{more}}\n{{link}}"
      : '{\n  "title": "{{alert.name}}",\n  "message": "{{fingerprints.count}} new after {{mark.kind}} {{mark.version}}: {{fingerprints.first}}",\n  "url": "{{link}}"\n}';
  }
  return bodyKind === "text"
    ? "{{alert.name}}: {{series}} {{value}} ≥ {{threshold}}\n{{query}}\n{{link}}"
    : '{\n  "title": "{{alert.name}}",\n  "message": "{{series}} {{value}} ≥ {{threshold}}",\n  "url": "{{link}}"\n}';
}
