import { histogramWindowNeedsDate } from "./fill-histogram";

const DAY_MS = 24 * 60 * 60 * 1000;

export function utcWindowStamp(
  ms: number,
  spanMs: number,
  nowMs = Date.now(),
  needsDate?: boolean,
): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const frac =
    spanMs <= 1000 ? `.${String(d.getUTCMilliseconds()).padStart(3, "0")}` : "";
  const hhmmss = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${frac}`;
  const ymd = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (spanMs >= DAY_MS) {
    return `${ymd} ${hhmmss.slice(0, 5)}`;
  }
  const today = new Date(nowMs);
  const sameDay =
    d.getUTCFullYear() === today.getUTCFullYear() &&
    d.getUTCMonth() === today.getUTCMonth() &&
    d.getUTCDate() === today.getUTCDate();
  const dated = needsDate ?? !sameDay;
  if (dated) {
    return `${ymd} ${hhmmss}`;
  }
  return hhmmss;
}

export type SearchWindow = { from: string | null; to: string | null };

/** The window the search used, as /api/search answered it; the clock until a reply. The first bar starts on the bar grid, not here. */
export function searchWindowMs(
  reply: SearchWindow | null,
  clock: { fromMs: number; toMs: number },
): { fromMs: number; toMs: number } {
  const fromMs = Date.parse(reply?.from ?? "");
  const toMs = Date.parse(reply?.to ?? "");
  return Number.isFinite(fromMs) && Number.isFinite(toMs) ? { fromMs, toMs } : clock;
}

export function windowHead(
  fromMs: number,
  toMs: number,
  spanMs: number,
  nowMs = Date.now(),
): string {
  const needsDate = histogramWindowNeedsDate(fromMs, spanMs, nowMs);
  return `${utcWindowStamp(fromMs, spanMs, nowMs, needsDate)} → ${utcWindowStamp(toMs, spanMs, nowMs, needsDate)}`;
}


/** The window a hunt's monitor band reads its stretches for, to the minute: a reply or a Live poll that moves it by seconds reads nothing new. */
export function bandWindowKey(window: { fromMs: number; toMs: number }): string {
  return `${Math.floor(window.fromMs / 60_000)}:${Math.floor(window.toMs / 60_000)}`;
}
