import { flattenAttrs } from "./attrs";

export const changeMarkKinds = ["deploy", "flag", "incident", "note"] as const;
export type ChangeMarkKind = (typeof changeMarkKinds)[number];

export const maxChangeMarks = 500;
export const maxChangeMarkTitle = 500;
export const maxChangeMarkId = 64;
const markIdRe = /^[A-Za-z0-9._:-]{1,64}$/;

export type ChangeMark = {
  id: string;
  ts: string;
  end_ts: string | null;
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

export function mintChangeMarkId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return `mk_${hex}`;
}

export function fallbackChangeMarkId(parts: {
  ts: string;
  kind: string;
  service: string;
  title: string;
}): string {
  const s = `${parts.ts}|${parts.kind}|${parts.service}|${parts.title}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `mk_${(h >>> 0).toString(16).padStart(8, "0")}`;
}

export function formatChangeMarkLabel(mark: {
  kind: ChangeMarkKind;
  service: string;
  title: string;
}): string {
  if (mark.kind === "deploy") {
    const where = mark.service.trim();
    return where
      ? `deployed: ${where} ${mark.title}`
      : `deployed: ${mark.title}`;
  }
  return `${mark.kind}: ${mark.title}`;
}

function parseOptionalTs(
  raw: unknown,
  field: string,
): string | null {
  if (raw == null || raw === "") {
    return null;
  }
  if (typeof raw !== "string" || Number.isNaN(Date.parse(raw))) {
    throw new InvalidChangeMarkError(`${field} must be an ISO timestamp`);
  }
  return new Date(raw).toISOString();
}

function parseOptionalId(raw: unknown): string | null {
  if (raw == null) {
    return null;
  }
  if (typeof raw !== "string") {
    throw new InvalidChangeMarkError("id must be a string");
  }
  const id = raw.trim();
  if (id.length === 0) {
    return null;
  }
  if (id.length > maxChangeMarkId || !markIdRe.test(id)) {
    throw new InvalidChangeMarkError(
      "id must be 1–64 letters, digits, or . _ : -",
    );
  }
  return id;
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
  const endTs = parseOptionalTs(rec.end_ts, "end_ts");
  if (endTs !== null && Date.parse(endTs) <= Date.parse(ts)) {
    throw new InvalidChangeMarkError("end_ts must be after ts");
  }
  const service =
    typeof rec.service === "string" ? rec.service.trim() : "";
  const attrs = flattenAttrs(
    rec.attrs && typeof rec.attrs === "object" && !Array.isArray(rec.attrs)
      ? (rec.attrs as Record<string, unknown>)
      : undefined,
  );
  return {
    id: parseOptionalId(rec.id) ?? mintChangeMarkId(),
    ts,
    end_ts: endTs,
    kind,
    service,
    title: titleRaw.slice(0, maxChangeMarkTitle),
    attrs,
  };
}
