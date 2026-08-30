import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { formatChangeMarkLabel, type ChangeMark } from "../../shared/change-mark";
import {
  compareFoldKind,
  compareFoldMinus,
  compareFoldNote,
  compareFoldPercent,
  compareFoldSeriesText,
  compareFoldShowDelta,
  compareFoldSideFromSearch,
  compareFoldSidesText,
  formatCompareFoldPercent,
  type CompareFoldKind,
  type CompareFoldSide,
} from "../../shared/compare-fold";
import { formatFingerprintCutDuration } from "../../shared/fingerprint-cut";
import { fingerprintAttr } from "../../shared/fingerprint-attr";
import { formatAggStat } from "@/fill-histogram";
import { formatFieldCount, useCountFormat } from "@/count-format";
import { cn } from "@/lib/utils";
import { facetValues } from "../query-tokens";
import { fingerprintCutHuntWindows } from "../fingerprint-cut";
import { compareFoldFetchKey } from "../compare-fold";
import type { SearchResult } from "../types";
import { MarkGlyph } from "./histogram-marks";

export type CompareFoldProps = {
  mark: ChangeMark;
  openedAt: string;
  q: string;
  agg: string | null;
  metric: string | null;
  ml: string;
  live: boolean;
  from: string;
  to: string;
  spanMs: number;
  huntFromMs: number;
  huntToMs: number;
  onClose: () => void;
};

type Sides = {
  before: CompareFoldSide;
  after: CompareFoldSide;
  refuse: string;
};

function hms(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

function formatSide(
  kind: CompareFoldKind,
  side: CompareFoldSide,
  formatCount: (n: number) => string,
): string {
  if (side.refused) {
    return "—";
  }
  switch (kind) {
    case "count":
      return formatCount(side.n);
    case "rate":
      return side.v == null ? "—" : `${formatAggStat(side.v)}/s`;
    case "numeric":
      return side.n > 0 && side.v != null ? formatAggStat(side.v) : "—";
    case "metric":
      return side.v == null ? "—" : formatAggStat(side.v);
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

function formatAbs(
  kind: CompareFoldKind,
  delta: number,
  formatCount: (n: number) => string,
): string {
  const sign = delta >= 0 ? "+" : compareFoldMinus;
  const abs = Math.abs(delta);
  switch (kind) {
    case "count":
      return `${sign}${formatCount(Math.round(abs))}`;
    case "rate":
      return `${sign}${formatAggStat(abs)}/s`;
    case "numeric":
    case "metric":
      return `${sign}${formatAggStat(abs)}`;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

async function searchSide(
  fromMs: number,
  toMs: number,
  input: Pick<CompareFoldProps, "q" | "agg" | "metric" | "ml">,
  signal: AbortSignal,
): Promise<SearchResult> {
  const params = new URLSearchParams();
  params.set("from", new Date(fromMs).toISOString());
  params.set("to", new Date(toMs).toISOString());
  params.set("events", "0");
  const qVal = input.q.trim();
  if (qVal) {
    params.set("q", qVal);
  }
  if (input.metric) {
    params.set("metric", input.metric);
    if (input.ml) {
      params.set("ml", input.ml);
    }
  } else if (input.agg) {
    params.set("agg", input.agg);
  }
  const res = await fetch(`/api/search?${params.toString()}`, { signal });
  if (res.status === 401) {
    throw new Error("Unauthorized. Sign in with basic auth.");
  }
  const json = (await res.json()) as SearchResult & { error?: string };
  if (!res.ok) {
    throw new Error(json.error ?? `Compare failed (${res.status})`);
  }
  return json;
}

export function CompareFold({
  mark,
  openedAt,
  q,
  agg,
  metric,
  ml,
  live,
  from,
  to,
  spanMs,
  huntFromMs,
  huntToMs,
  onClose,
}: CompareFoldProps) {
  const countFormat = useCountFormat();
  const formatCount = (n: number) => formatFieldCount(n, countFormat);
  const windows = fingerprintCutHuntWindows(mark, openedAt, huntFromMs, huntToMs);
  const kind = compareFoldKind(agg, metric);
  const series = compareFoldSeriesText({
    e1: facetValues(q, fingerprintAttr),
    agg,
    metric,
  });
  const fetchKey = compareFoldFetchKey({
    q,
    live,
    spanMs,
    from,
    to,
    agg,
    metric,
    ml,
  });
  const [sides, setSides] = useState<Sides | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (windows.dead) {
      setSides(null);
      setError(null);
      return;
    }
    const ac = new AbortController();
    setError(null);
    void (async () => {
      try {
        const [beforeJson, afterJson] = await Promise.all([
          searchSide(windows.beforeFrom, windows.beforeTo, { q, agg, metric, ml }, ac.signal),
          searchSide(windows.afterFrom, windows.afterTo, { q, agg, metric, ml }, ac.signal),
        ]);
        if (ac.signal.aborted) {
          return;
        }
        const before = compareFoldSideFromSearch(beforeJson, kind);
        const after = compareFoldSideFromSearch(afterJson, kind);
        const refuse =
          (beforeJson.scan?.source === "refused" ? beforeJson.scan.reason : "") ||
          (afterJson.scan?.source === "refused" ? afterJson.scan.reason : "") ||
          (beforeJson.agg?.source === "refused" ? beforeJson.agg.reason ?? "" : "") ||
          (afterJson.agg?.source === "refused" ? afterJson.agg.reason ?? "" : "");
        setSides({ before, after, refuse });
      } catch (err) {
        if (ac.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
          return;
        }
        setError(err instanceof Error ? err.message : "Compare failed");
      }
    })();
    return () => ac.abort();
  }, [mark.id, openedAt, fetchKey, windows.dead, windows.beforeFrom, windows.beforeTo, windows.afterFrom, windows.afterTo, q, agg, metric, ml, kind]);

  const nowMs = Date.now();
  const frozen =
    live && !windows.banded && !windows.dead && nowMs - windows.afterTo > 1000;
  const before = sides?.before ?? {
    v: null,
    n: 0,
    empty: true,
    refused: false,
  };
  const after = sides?.after ?? {
    v: null,
    n: 0,
    empty: true,
    refused: false,
  };
  const loaded = sides != null;
  const bothEmpty =
    loaded && kind !== "metric" && before.empty && after.empty && !windows.dead;
  const beforeTxt =
    windows.dead || bothEmpty || !loaded
      ? "—"
      : formatSide(kind, before, formatCount);
  const afterTxt =
    windows.dead || bothEmpty || !loaded
      ? "—"
      : formatSide(kind, after, formatCount);
  const showDelta =
    loaded && compareFoldShowDelta(windows, kind, before, after);
  const delta = showDelta ? (after.v ?? 0) - (before.v ?? 0) : null;
  const pct =
    showDelta && !before.empty
      ? compareFoldPercent(before.v ?? 0, after.v ?? 0)
      : null;
  const note =
    error ??
    (windows.dead
      ? compareFoldNote({
          windows,
          kind,
          before,
          after,
          formatDuration: formatFingerprintCutDuration,
        })
      : loaded
        ? sides.refuse ||
          compareFoldNote({
            windows,
            kind,
            before,
            after,
            formatDuration: formatFingerprintCutDuration,
          })
        : "");
  const sidesTxt = compareFoldSidesText({
    windows,
    frozen,
    frozenStamp: hms(windows.afterTo),
    formatDuration: formatFingerprintCutDuration,
  });
  const title = windows.dead
    ? "No after side in this window"
    : `after ${hms(windows.afterFrom)} → ${hms(windows.afterTo)} · before ${hms(windows.beforeFrom)} → ${hms(windows.beforeTo)} — equal windows on the hunt's own slice`;

  return (
    <div
      data-compare-fold=""
      title={title}
      className="mt-1.5 mr-2.5 ml-[47px] flex h-[30px] min-w-0 shrink-0 items-center gap-[7px] overflow-hidden rounded-[4.4px] border bg-[#0f0f11] pr-1 pl-2.5"
      style={{ borderColor: "oklch(0.906 0.014 84 / 28%)" }}
    >
      <MarkGlyph kind={mark.kind} size={11} />
      <span className="min-w-[56px] truncate text-[12px] font-semibold whitespace-nowrap">
        vs {formatChangeMarkLabel(mark)}
      </span>
      <span className="font-mono text-[11px] text-muted-foreground/45">·</span>
      <span
        className="min-w-[34px] truncate font-mono text-[10.5px] whitespace-nowrap"
        style={{ color: series.overlay ? "#a78bfa" : "oklch(0.985 0 0 / 85%)" }}
      >
        {series.text}
      </span>
      <span className="font-mono text-[11px] text-muted-foreground/45">·</span>
      <span className="text-[10.5px] text-muted-foreground whitespace-nowrap">
        before
      </span>
      <span className="font-mono text-[11.5px] whitespace-nowrap tabular-nums">
        {beforeTxt}
      </span>
      <span className="text-[10.5px] text-muted-foreground whitespace-nowrap">
        →
      </span>
      <span className="text-[10.5px] text-muted-foreground whitespace-nowrap">
        {windows.banded ? "during" : "after"}
      </span>
      <span className="font-mono text-[11.5px] whitespace-nowrap tabular-nums">
        {afterTxt}
      </span>
      {showDelta && delta != null ? (
        <>
          <span className="font-mono text-[11px] text-muted-foreground/45">
            ·
          </span>
          <span className="font-mono text-[11.5px] whitespace-nowrap tabular-nums">
            {formatAbs(kind, delta, formatCount)}
          </span>
        </>
      ) : null}
      {pct != null ? (
        <span
          className="inline-flex h-[18px] shrink-0 items-center rounded-[3.4px] border px-1.5 font-mono text-[11px] whitespace-nowrap"
          style={{
            borderColor: "oklch(0.906 0.014 84 / 35%)",
            color: "oklch(0.906 0.014 84)",
          }}
        >
          {formatCompareFoldPercent(pct)}
        </span>
      ) : null}
      {note ? (
        <>
          <span className="shrink-0 text-[10.5px] text-amber-400">▲</span>
          <span className="min-w-0 truncate text-[10.5px] whitespace-nowrap text-[oklch(0.906_0.014_84_/_90%)]">
            {note}
          </span>
        </>
      ) : null}
      <span className="min-w-2 flex-1" />
      {sidesTxt ? (
        <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground whitespace-nowrap">
          {sidesTxt}
        </span>
      ) : null}
      <button
        type="button"
        title="Dismiss compare — the mark stays selected; the cut, if open, stays"
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-[4.4px] text-muted-foreground",
          "hover:bg-accent hover:text-foreground",
        )}
        onClick={onClose}
      >
        <X className="size-3" strokeWidth={2.2} />
      </button>
    </div>
  );
}
