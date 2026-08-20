import type { HistogramIntervalId } from "../query/histogram";
import { histogramWindowNeedsDate } from "./fill-histogram";
import { formatSpanShort } from "./time-range";

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

export function windowHead(
  fromMs: number,
  toMs: number,
  spanMs: number,
  nowMs = Date.now(),
): string {
  const needsDate = histogramWindowNeedsDate(fromMs, spanMs, nowMs);
  return `${utcWindowStamp(fromMs, spanMs, nowMs, needsDate)} → ${utcWindowStamp(toMs, spanMs, nowMs, needsDate)}`;
}

export function windowMeta(
  spanMs: number,
  interval: HistogramIntervalId,
): string {
  return `UTC · ${formatSpanShort(spanMs)} · ${interval} bars`;
}
