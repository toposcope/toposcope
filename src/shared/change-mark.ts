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

export type ParsedChangeMark = {
  mark: ChangeMark;
  idProvided: boolean;
  tsProvided: boolean;
};

export type ChangeMarkClockState = Pick<ChangeMark, "id" | "ts" | "end_ts">;

function preferChangeMark(next: ChangeMarkClockState, prev: ChangeMarkClockState): boolean {
  const cmp = Date.parse(next.ts) - Date.parse(prev.ts);
  if (cmp !== 0) {
    return cmp > 0;
  }
  if (next.end_ts && !prev.end_ts) {
    return true;
  }
  if (!next.end_ts && prev.end_ts) {
    return false;
  }
  if (next.end_ts && prev.end_ts) {
    return Date.parse(next.end_ts) >= Date.parse(prev.end_ts);
  }
  return true;
}

export function ciDeployMarkId(service: string, title: string): string {
  const svc = service.trim();
  const tag = title.trim();
  const raw = svc ? `deploy-${svc}-${tag}` : `deploy-${tag}`;
  const id = raw
    .replace(/[^A-Za-z0-9._:-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxChangeMarkId);
  if (!id || !markIdRe.test(id)) {
    throw new InvalidChangeMarkError(
      "id must be 1–64 letters, digits, or . _ : -",
    );
  }
  return id;
}

export function ciDeployMark(input: {
  title: string;
  sha: string;
  service?: string;
  source: "github" | "gitlab";
}): {
  kind: "deploy";
  title: string;
  service: string;
  id: string;
  attrs: { version: string; sha: string; source: string };
} {
  const title = input.title.trim();
  if (title.length === 0) {
    throw new InvalidChangeMarkError("title is required");
  }
  const service = input.service?.trim() ?? "";
  return {
    kind: "deploy",
    title: title.slice(0, maxChangeMarkTitle),
    service,
    id: ciDeployMarkId(service, title),
    attrs: {
      version: title.slice(0, maxChangeMarkTitle),
      sha: input.sha,
      source: input.source,
    },
  };
}

function assertEndAfterStart(endTs: string, startTs: string): void {
  if (Date.parse(endTs) <= Date.parse(startTs)) {
    throw new InvalidChangeMarkError("end_ts must be after ts");
  }
}

export function marksToInsert(
  parsed: ParsedChangeMark[],
  existing: Iterable<ChangeMarkClockState>,
  now: string = new Date().toISOString(),
): ChangeMark[] {
  const state = new Map<string, ChangeMarkClockState>();
  for (const row of existing) {
    const prev = state.get(row.id);
    if (!prev || preferChangeMark(row, prev)) {
      state.set(row.id, { id: row.id, ts: row.ts, end_ts: row.end_ts });
    }
  }
  const out: ChangeMark[] = [];
  for (const { mark, idProvided, tsProvided } of parsed) {
    const latest = idProvided ? state.get(mark.id) : undefined;
    if (latest) {
      if (latest.end_ts) {
        continue;
      }
      if (mark.end_ts) {
        assertEndAfterStart(mark.end_ts, latest.ts);
        const closed: ChangeMark = {
          ...mark,
          ts: latest.ts,
          end_ts: mark.end_ts,
        };
        out.push(closed);
        state.set(closed.id, {
          id: closed.id,
          ts: closed.ts,
          end_ts: closed.end_ts,
        });
      }
      continue;
    }
    const ts = tsProvided ? mark.ts : now;
    if (mark.end_ts) {
      assertEndAfterStart(mark.end_ts, ts);
    }
    const inserted: ChangeMark = { ...mark, ts };
    out.push(inserted);
    state.set(inserted.id, {
      id: inserted.id,
      ts: inserted.ts,
      end_ts: inserted.end_ts,
    });
  }
  return out;
}

export function marksIngestBody(
  single: boolean,
  ids: string[],
  ingested: number,
): { ingested: number; id: string } | { ingested: number; ids: string[] } {
  if (single) {
    return { ingested, id: ids[0] ?? "" };
  }
  return { ingested, ids };
}

export function keepLatestChangeMarkPerId(marks: ChangeMark[]): ChangeMark[] {
  const byId = new Map<string, ChangeMark>();
  for (const mark of marks) {
    const prev = byId.get(mark.id);
    if (!prev || preferChangeMark(mark, prev)) {
      byId.set(mark.id, mark);
    }
  }
  return [...byId.values()].sort(
    (a, b) => Date.parse(a.ts) - Date.parse(b.ts),
  );
}

export function parseChangeMarkRequest(input: unknown): ParsedChangeMark {
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
  const tsProvided =
    typeof tsRaw === "string" && !Number.isNaN(Date.parse(tsRaw));
  const ts = tsProvided
    ? new Date(tsRaw as string).toISOString()
    : new Date().toISOString();
  const endTs = parseOptionalTs(rec.end_ts, "end_ts");
  const callerId = parseOptionalId(rec.id);
  if (endTs !== null && tsProvided && callerId === null) {
    assertEndAfterStart(endTs, ts);
  }
  const service =
    typeof rec.service === "string" ? rec.service.trim() : "";
  const attrs = flattenAttrs(
    rec.attrs && typeof rec.attrs === "object" && !Array.isArray(rec.attrs)
      ? (rec.attrs as Record<string, unknown>)
      : undefined,
  );
  return {
    mark: {
      id: callerId ?? mintChangeMarkId(),
      ts,
      end_ts: endTs,
      kind,
      service,
      title: titleRaw.slice(0, maxChangeMarkTitle),
      attrs,
    },
    idProvided: callerId !== null,
    tsProvided,
  };
}

export function parseChangeMark(input: unknown): ChangeMark {
  return parseChangeMarkRequest(input).mark;
}
