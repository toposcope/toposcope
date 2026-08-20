import { isAttrIdent, maxPromotedCols } from "../shared/attrs";
import type { LogEvent } from "./types";

export const promoMinPx = 44;
export const promoMaxPx = 96;

const headCh = 8;
const valCh = 7.2;
const headCapPx = 68;
const numLike = /^-?\d+(\.\d+)?$/;
const suggestMinCoverage = 0.5;
const suggestMaxUnique = 20;
const suggestN = 3;

export type PromoMetrics = { w: number; num: boolean };

export type PromoPickItem = {
  k: string;
  on: boolean;
  blocked: boolean;
  meta: string;
  title: string;
};

export function promoCellValue(event: LogEvent, key: string): string | null {
  const attrs = event.attrs;
  if (!attrs) {
    return null;
  }
  const raw = Object.prototype.hasOwnProperty.call(attrs, key)
    ? attrs[key]
    : attrs[key.toLowerCase()];
  if (raw === null || raw === undefined || raw === "") {
    return null;
  }
  if (typeof raw === "object") {
    return JSON.stringify(raw);
  }
  const text = String(raw);
  return text.length === 0 ? null : text;
}

export function promoMetrics(key: string, vals: string[]): PromoMetrics {
  const head = Math.min(key.length * headCh + 16, headCapPx);
  const val = vals.reduce((max, item) => Math.max(max, item.length), 1) * valCh + 10;
  const numeric = vals.length > 1 && vals.every((item) => numLike.test(item));
  return {
    w: Math.round(Math.max(promoMinPx, Math.min(promoMaxPx, Math.max(head, val)))),
    num: numeric && new Set(vals.map((item) => item.length)).size > 1,
  };
}

function keysOnPage(events: LogEvent[]): Map<string, string[]> {
  const sample = new Map<string, string[]>();
  for (const event of events) {
    for (const raw of Object.keys(event.attrs ?? {})) {
      const key = raw.toLowerCase();
      if (!isAttrIdent(key)) {
        continue;
      }
      const value = promoCellValue(event, key);
      if (value === null) {
        continue;
      }
      const list = sample.get(key) ?? [];
      list.push(value);
      sample.set(key, list);
    }
  }
  return sample;
}

export function promoPicker(
  events: LogEvent[],
  promoted: string[],
): {
  suggested: PromoPickItem[];
  other: PromoPickItem[];
  metrics: Record<string, PromoMetrics>;
  atCap: boolean;
} {
  const sample = keysOnPage(events);
  const n = events.length;
  const offer = [...sample.keys()];
  const orphans = promoted.filter((key) => !sample.has(key));
  const coverage = (key: string) => (n === 0 ? 0 : (sample.get(key)?.length ?? 0) / n);
  const unique = (key: string) => new Set(sample.get(key) ?? []).size;
  const scannable = (key: string) =>
    coverage(key) >= suggestMinCoverage && unique(key) <= suggestMaxUnique;
  const byCoverage = (a: string, b: string) => coverage(b) - coverage(a) || a.localeCompare(b);
  const suggestedKeys = offer.filter(scannable).sort(byCoverage).slice(0, suggestN);
  const otherKeys = offer
    .filter((key) => !suggestedKeys.includes(key))
    .sort(byCoverage)
    .concat(orphans);
  const atCap = promoted.length >= maxPromotedCols;
  const item = (key: string): PromoPickItem => {
    const on = promoted.includes(key);
    const blocked = !on && atCap;
    const cov = coverage(key);
    const nVals = unique(key);
    const meta = sample.has(key)
      ? `${Math.round(cov * 100)}% · ${nVals} value${nVals === 1 ? "" : "s"}`
      : "not on this page";
    return {
      k: key,
      on,
      blocked,
      meta,
      title: blocked
        ? `Cap is ${maxPromotedCols} columns — remove one first`
        : on
          ? `Remove ${key}`
          : `Show ${key} between Host and Message`,
    };
  };
  const metrics: Record<string, PromoMetrics> = {};
  for (const key of promoted) {
    metrics[key] = promoMetrics(key, sample.get(key) ?? []);
  }
  return {
    suggested: suggestedKeys.map(item),
    other: otherKeys.map(item),
    metrics,
    atCap,
  };
}

export function promoExtraTracks(
  promoted: string[],
  metrics: Record<string, PromoMetrics>,
): string {
  return promoted
    .map((key) => `minmax(${promoMinPx}px,${metrics[key]?.w ?? promoMinPx}px)`)
    .join(" ");
}

export function togglePromotedCol(promoted: string[], key: string): string[] {
  if (promoted.includes(key)) {
    return promoted.filter((item) => item !== key);
  }
  if (promoted.length >= maxPromotedCols) {
    return promoted;
  }
  return [...promoted, key];
}
