import { flattenAttrs } from "./attrs";

export const changeMarkKinds = ["deploy", "flag", "incident", "note"] as const;
export type ChangeMarkKind = (typeof changeMarkKinds)[number];

export const maxChangeMarks = 500;
export const maxChangeMarkTitle = 500;

export type ChangeMark = {
  ts: string;
  kind: ChangeMarkKind;
  service: string;
  title: string;
  attrs: Record<string, string>;
};

export class InvalidChangeMarkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidChangeMarkError";
  }
}

const kinds = new Set<string>(changeMarkKinds);

export function parseChangeMarkKind(
  raw: string | null | undefined,
): ChangeMarkKind | null {
  if (!raw) {
    return null;
  }
  const kind = raw.trim().toLowerCase();
  return kinds.has(kind) ? (kind as ChangeMarkKind) : null;
}

export function parseChangeMark(input: unknown): ChangeMark {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new InvalidChangeMarkError("Invalid change mark");
  }
  const rec = input as Record<string, unknown>;
  const kind = parseChangeMarkKind(typeof rec.kind === "string" ? rec.kind : "");
  if (!kind) {
    throw new InvalidChangeMarkError(
      "kind must be deploy, flag, incident, or note",
    );
  }
  const titleRaw = typeof rec.title === "string" ? rec.title.trim() : "";
  if (titleRaw.length === 0) {
    throw new InvalidChangeMarkError("title is required");
  }
  const tsRaw = rec.ts;
  const ts =
    typeof tsRaw === "string" && !Number.isNaN(Date.parse(tsRaw))
      ? new Date(tsRaw).toISOString()
      : new Date().toISOString();
  const service =
    typeof rec.service === "string" ? rec.service.trim() : "";
  const attrs = flattenAttrs(
    rec.attrs && typeof rec.attrs === "object" && !Array.isArray(rec.attrs)
      ? (rec.attrs as Record<string, unknown>)
      : undefined,
  );
  return {
    ts,
    kind,
    service,
    title: titleRaw.slice(0, maxChangeMarkTitle),
    attrs,
  };
}
