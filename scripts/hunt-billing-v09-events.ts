import { computeFingerprint } from "../src/shared/fingerprint";
import { fakeLogEvent } from "../src/shared/fake-event";
import type { LogLevel } from "../src/shared/log-event";

export const HUNT_Q = "level:error service:billing";
export const HUNT_WINDOW_MS = 60 * 60 * 1000;
export const HUNT_BACKGROUND_N = 5_000;
export const HUNT_MARK_TITLE = "v0.9";
export const HUNT_MARK_SERVICE = "billing";
export const HUNT_MARK_ID = "deploy-billing-v0.9";

export type HuntEvent = {
  ts: string;
  service: string;
  host: string;
  level: LogLevel;
  message: string;
  attrs: Record<string, string | number>;
};

export type HuntBug = {
  message: string;
  type: string;
  framesJson: string;
  after: number;
};

/** After-only framed bugs. Distinct in-app frames so each gets its own e1. */
export const huntFirstSeen: readonly HuntBug[] = [
  {
    message: "checkout total mismatch",
    type: "RuntimeError",
    framesJson: JSON.stringify([
      { file: "billing/totals.ts", function: "sumCart", in_app: true },
      { file: "vendor/http.ts", function: "request" },
    ]),
    after: 18,
  },
  {
    message: "invoice PDF render failed",
    type: "TypeError",
    framesJson: JSON.stringify([
      { file: "billing/invoice.ts", function: "renderPdf", in_app: true },
    ]),
    after: 12,
  },
  {
    message: "stripe webhook 409",
    type: "RuntimeError",
    framesJson: JSON.stringify([
      { file: "billing/webhook.ts", function: "handleStripe", in_app: true },
    ]),
    after: 9,
  },
];

export const huntStillHere = {
  message: "timeout",
  before: 24,
  after: 28,
} as const;

export type HuntSlice = {
  fromMs: number;
  toMs: number;
  markMs: number;
  from: string;
  to: string;
  markTs: string;
  q: string;
  mark: {
    kind: "deploy";
    title: string;
    service: string;
    id: string;
    ts: string;
    attrs: { version: string; source: string };
  };
  events: HuntEvent[];
  billingErrorBefore: number;
  billingErrorAfter: number;
};

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function spread(
  count: number,
  fromMs: number,
  toMs: number,
  make: (i: number, tsMs: number) => HuntEvent,
): HuntEvent[] {
  if (count <= 0) {
    return [];
  }
  const span = Math.max(1, toMs - fromMs);
  return Array.from({ length: count }, (_, i) => {
    const tsMs = fromMs + Math.floor(((i + 1) / (count + 1)) * span);
    return make(i, tsMs);
  });
}

function billingError(
  tsMs: number,
  message: string,
  extra: Record<string, string | number> = {},
): HuntEvent {
  return {
    ts: iso(tsMs),
    service: "billing",
    host: "billing-1",
    level: "error",
    message,
    attrs: {
      path: "/v1/checkout",
      status: 500,
      duration_ms: 640,
      ...extra,
    },
  };
}

function framed(
  tsMs: number,
  bug: HuntBug,
  versioned: boolean,
): HuntEvent {
  return billingError(tsMs, bug.message, {
    "exception.type": bug.type,
    "exception.frames": bug.framesJson,
    ...(versioned ? { version: HUNT_MARK_TITLE } : {}),
  });
}

export function huntBugFingerprint(bug: HuntBug): string {
  const hex = computeFingerprint("error", bug.message, {
    "exception.type": bug.type,
    "exception.frames": bug.framesJson,
  });
  if (!hex) {
    throw new Error(`hunt bug ${bug.message} must fingerprint`);
  }
  return hex;
}

export function buildHuntSlice(nowMs: number): HuntSlice {
  const toMs = nowMs;
  const fromMs = nowMs - HUNT_WINDOW_MS;
  const markMs = fromMs + HUNT_WINDOW_MS / 2;
  const beforeTo = markMs - 1_000;
  const afterFrom = markMs + 1_000;

  const firstSeenHexes = new Set(huntFirstSeen.map(huntBugFingerprint));
  const background: HuntEvent[] = [];
  for (let i = 0; i < HUNT_BACKGROUND_N; i++) {
    const event = fakeLogEvent({
      i,
      n: HUNT_BACKGROUND_N,
      now: toMs,
      windowMs: HUNT_WINDOW_MS,
    });
    if (
      event.service === "billing" &&
      (event.level === "error" || event.level === "fatal")
    ) {
      continue;
    }
    const hex = computeFingerprint(event.level, event.message, event.attrs);
    if (hex && firstSeenHexes.has(hex)) {
      continue;
    }
    background.push(event);
  }

  const stillBefore = spread(
    huntStillHere.before,
    fromMs,
    beforeTo,
    (_i, tsMs) => billingError(tsMs, huntStillHere.message),
  );
  const stillAfter = spread(
    huntStillHere.after,
    afterFrom,
    toMs,
    (_i, tsMs) =>
      billingError(tsMs, huntStillHere.message, { version: HUNT_MARK_TITLE }),
  );
  const firstSeen = huntFirstSeen.flatMap((bug) =>
    spread(bug.after, afterFrom, toMs, (i, tsMs) => framed(tsMs, bug, i % 2 === 0)),
  );

  const events = [
    ...background,
    ...stillBefore,
    ...stillAfter,
    ...firstSeen,
  ];

  return {
    fromMs,
    toMs,
    markMs,
    from: iso(fromMs),
    to: iso(toMs),
    markTs: iso(markMs),
    q: HUNT_Q,
    mark: {
      kind: "deploy",
      title: HUNT_MARK_TITLE,
      service: HUNT_MARK_SERVICE,
      id: HUNT_MARK_ID,
      ts: iso(markMs),
      attrs: { version: HUNT_MARK_TITLE, source: "hunt" },
    },
    events,
    billingErrorBefore: stillBefore.length,
    billingErrorAfter: stillAfter.length + firstSeen.length,
  };
}

export type HuntManifest = {
  q: string;
  from: string;
  to: string;
  markId: string;
  markLabel: string;
  ui: string;
};
