const ERROR_MAX = 200;

export type WebhookOutcome = {
  ok: boolean;
  status: string;
  error: string | null;
};

export type DeliveryState = {
  last_fired_at: number | null;
  consecutive_failures: number;
  last_status: string | null;
  last_error: string | null;
};

export type DeliveryUpdate = {
  last_attempt_at: number;
  last_status: string | null;
  last_error: string | null;
  consecutive_failures: number;
  last_fired_at: number | null;
};

export function clipError(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= ERROR_MAX) {
    return trimmed;
  }
  return trimmed.slice(0, ERROR_MAX);
}

export function outcomeFromHttp(status: number, statusText: string): WebhookOutcome {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status: String(status),
    error: ok ? null : clipError(statusText || `HTTP ${status}`),
  };
}

export function outcomeFromError(err: unknown): WebhookOutcome {
  if (isAbort(err)) {
    return { ok: false, status: "timeout", error: "webhook timed out" };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, status: "error", error: clipError(message) };
}

export function nextEvalAttempt(
  prev: DeliveryState,
  stamp: {
    at: number;
    status: "refused" | "error" | "ok";
    error: string | null;
  },
): DeliveryUpdate {
  if (stamp.status === "ok") {
    const clear = prev.last_status === "refused" || prev.last_status === "error";
    return {
      last_attempt_at: stamp.at,
      last_status: clear ? null : prev.last_status,
      last_error: clear ? null : prev.last_error,
      consecutive_failures: prev.consecutive_failures,
      last_fired_at: prev.last_fired_at,
    };
  }
  return {
    last_attempt_at: stamp.at,
    last_status: stamp.status,
    last_error: stamp.error ? clipError(stamp.error) : null,
    consecutive_failures: prev.consecutive_failures,
    last_fired_at: prev.last_fired_at,
  };
}

export function nextDelivery(
  prev: DeliveryState,
  attempt: WebhookOutcome & { at: number },
): DeliveryUpdate {
  if (attempt.ok) {
    return {
      last_attempt_at: attempt.at,
      last_status: attempt.status,
      last_error: null,
      consecutive_failures: 0,
      last_fired_at: attempt.at,
    };
  }
  return {
    last_attempt_at: attempt.at,
    last_status: attempt.status,
    last_error: attempt.error,
    consecutive_failures: prev.consecutive_failures + 1,
    last_fired_at: prev.last_fired_at,
  };
}

function isAbort(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  if (!("name" in err) || err.name !== "AbortError") {
    return false;
  }
  return true;
}
