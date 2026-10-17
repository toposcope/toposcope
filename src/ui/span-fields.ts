import type { Span } from "../shared/span";

export type SpanField = { k: string; v: string };

export type SpanFieldGroups = {
  /** `exception.*` as `type` / `message` / `stacktrace`, then `e1`; null when none was recorded. */
  exception: SpanField[] | null;
  span: SpanField[];
  resource: SpanField[];
};

const exceptionOrder = ["exception.type", "exception.message", "exception.stacktrace"] as const;

/**
 * A stored span keeps its resource's attributes and its own in one map, so the
 * resource is told by OpenTelemetry's resource namespaces: what a stock SDK and
 * its detectors set (`service.version`, `host.name`, `process.runtime.name`, …).
 */
const resourceNamespaces = [
  "service.",
  "host.",
  "os.",
  "process.",
  "telemetry.",
  "container.",
  "k8s.",
  "cloud.",
  "deployment.",
  "device.",
  "faas.",
  "webengine.",
  "browser.",
  "aws.ecs.",
  "aws.eks.",
  "aws.log.",
  "gcp.",
  "heroku.",
] as const;

export function isResourceKey(key: string): boolean {
  return resourceNamespaces.some((ns) => key.startsWith(ns));
}

export function spanFieldGroups(span: Span): SpanFieldGroups {
  const attrs = span.attrs ?? {};
  const exception: SpanField[] = [];
  for (const key of exceptionOrder) {
    const v = attrs[key];
    if (v !== undefined && v !== "") {
      exception.push({ k: key.slice("exception.".length), v });
    }
  }
  const hasException = exception.length > 0;
  if (hasException && attrs.e1) {
    exception.push({ k: "e1", v: attrs.e1 });
  }
  const own: SpanField[] = [];
  const resource: SpanField[] = [];
  for (const [k, v] of Object.entries(attrs)) {
    if (v === "" || (exceptionOrder as readonly string[]).includes(k)) {
      continue;
    }
    if (k === "e1" && hasException) {
      continue;
    }
    (isResourceKey(k) ? resource : own).push({ k, v });
  }
  return { exception: hasException ? exception : null, span: own, resource };
}

/** A stack past this many lines keeps its two ends and folds the middle. */
export const stackFoldOver = 20;
export const stackHeadLines = 8;
export const stackTailLines = 6;

export type StackFold = {
  lines: number;
  head: string;
  /** Null when the stack is shown whole. */
  hidden: { count: number; text: string } | null;
  tail: string;
};

/**
 * A Python traceback raises at its foot and a Node stack at its head, so a long
 * stack keeps both ends: the raise is on screen whichever it is.
 */
export function foldStack(stack: string): StackFold {
  const all = stack.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  if (all.length <= stackFoldOver) {
    return { lines: all.length, head: all.join("\n"), hidden: null, tail: "" };
  }
  const head = all.slice(0, stackHeadLines);
  const hidden = all.slice(stackHeadLines, all.length - stackTailLines);
  const tail = all.slice(all.length - stackTailLines);
  return {
    lines: all.length,
    head: head.join("\n"),
    hidden: { count: hidden.length, text: hidden.join("\n") },
    tail: tail.join("\n"),
  };
}

/** The resource folded: its first two pairs, for the closed group's line. */
export function resourcePreview(fields: SpanField[]): string {
  return fields
    .slice(0, 2)
    .map((field) => `${field.k} ${field.v}`)
    .join(" · ");
}

/** The span as `/api/traces` gives it: what JSON shows and Copy writes. */
export function spanJson(span: Span): string {
  return JSON.stringify(span, null, 2);
}

/** `+100ms` from the trace's start; nothing for a span that starts it. */
export function spanOffsetLabel(startMs: number, format: (ms: number) => string): string {
  return startMs > 0 ? `+${format(startMs)}` : "";
}
