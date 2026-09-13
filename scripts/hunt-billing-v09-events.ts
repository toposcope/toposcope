import { computeFingerprint } from "../src/shared/fingerprint";
import { fakeLogEvent } from "../src/shared/fake-event";
import type { LogLevel } from "../src/shared/log-event";

export const HUNT_Q = "level:error service:billing";
export const HUNT_WINDOW_MS = 60 * 60 * 1000;
export const HUNT_BACKGROUND_N = 5_000;
export const HUNT_MARK_TITLE = "v0.9";
export const HUNT_MARK_SERVICE = "billing";
export const HUNT_MARK_ID = "deploy-billing-v0.9";
export const HUNT_CUSTOMER = "acme";
export const HUNT_FLAG = "new-checkout";
export const HUNT_ROW_COLS = "version,customer,flag";
export const HUNT_PROBE_METRIC = "up";
export const HUNT_PROBE_ML = "service:billing";
export const HUNT_PROBE_STEP_MS = 60_000;
export const HUNT_PROBE_DOWN_AFTER_MS = 10 * 60 * 1000;

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
  host: string;
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
    host: "billing-1",
    after: 4,
  },
  {
    message: "invoice PDF render failed",
    type: "TypeError",
    framesJson: JSON.stringify([
      { file: "billing/invoice.ts", function: "renderPdf", in_app: true },
    ]),
    host: "billing-2",
    after: 21,
  },
  {
    message: "stripe webhook 409",
    type: "RuntimeError",
    framesJson: JSON.stringify([
      { file: "billing/webhook.ts", function: "handleStripe", in_app: true },
    ]),
    host: "billing-3",
    after: 63,
  },
];

export const huntStillHere = {
  message: "timeout",
} as const;

/** Equal-window still-here plus the first-seen bug that is the host's delta. */
export const huntHostSlices = [
  { host: "billing-1", still: 850, bugAfter: 4 },
  { host: "billing-2", still: 525, bugAfter: 21 },
  { host: "billing-3", still: 700, bugAfter: 63 },
] as const;

export const huntHostPercents = ["+0.5%", "+4%", "+9%"] as const;

export type HuntProbe = {
  service: string;
  up: 0 | 1;
  ts: string;
  check: string;
};

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
  probes: HuntProbe[];
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
  host = "billing-1",
): HuntEvent {
  return {
    ts: iso(tsMs),
    service: "billing",
    host,
    level: "error",
    message,
    attrs: {
      path: "/v1/checkout",
      status: 500,
      duration_ms: 640,
      customer: HUNT_CUSTOMER,
      ...extra,
    },
  };
}

function framed(tsMs: number, bug: HuntBug): HuntEvent {
  return billingError(
    tsMs,
    bug.message,
    {
      "exception.type": bug.type,
      "exception.frames": bug.framesJson,
      version: HUNT_MARK_TITLE,
      flag: HUNT_FLAG,
    },
    bug.host,
  );
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

  const stillBefore = huntHostSlices.flatMap((slice) =>
    spread(slice.still, fromMs, beforeTo, (_i, tsMs) =>
      billingError(tsMs, huntStillHere.message, {}, slice.host),
    ),
  );
  const stillAfter = huntHostSlices.flatMap((slice) =>
    spread(slice.still, afterFrom, toMs, (_i, tsMs) =>
      billingError(tsMs, huntStillHere.message, { version: HUNT_MARK_TITLE }, slice.host),
    ),
  );
  const firstSeen = huntFirstSeen.flatMap((bug) =>
    spread(bug.after, afterFrom, toMs, (_i, tsMs) => framed(tsMs, bug)),
  );

  const events = [
    ...background,
    ...stillBefore,
    ...stillAfter,
    ...firstSeen,
  ];
  const probes = buildHuntProbes(fromMs, toMs, markMs);

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
    probes,
    billingErrorBefore: stillBefore.length,
    billingErrorAfter: stillAfter.length + firstSeen.length,
  };
}

export function buildHuntProbes(
  fromMs: number,
  toMs: number,
  markMs: number,
): HuntProbe[] {
  const probes: HuntProbe[] = [];
  const downUntil = markMs + HUNT_PROBE_DOWN_AFTER_MS;
  for (let tsMs = fromMs; tsMs <= toMs; tsMs += HUNT_PROBE_STEP_MS) {
    const afterMark = tsMs > markMs;
    const down = afterMark && tsMs <= downUntil;
    probes.push({
      service: HUNT_MARK_SERVICE,
      up: down ? 0 : 1,
      ts: iso(tsMs),
      check: "hunt",
    });
  }
  return probes;
}

export type HuntManifest = {
  q: string;
  from: string;
  to: string;
  markId: string;
  markLabel: string;
  ui: string;
};
