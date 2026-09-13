import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { formatChangeMarkLabel, type ChangeMark } from "../../shared/change-mark";
import {
  compareFoldKind,
  compareFoldMinus,
  compareFoldNote,
  compareFoldPercent,
  compareFoldRowKeys,
  compareFoldSeriesText,
  compareFoldSeriesTotal,
  compareFoldShowDelta,
  compareFoldSideFromCount,
  compareFoldSideFromSearch,
  compareFoldSidesText,
  compareFoldTotals,
  formatCompareFoldPercent,
  type CompareFoldKind,
  type CompareFoldSide,
} from "../../shared/compare-fold";
import { formatFingerprintCutDuration } from "../../shared/fingerprint-cut";
import { fingerprintAttr } from "../../shared/fingerprint-attr";
import { formatAggStat } from "@/fill-histogram";
import { formatFieldCount, useCountFormat } from "@/count-format";
import { cn } from "@/lib/utils";
import { facetValues, setFieldToken } from "../query-tokens";
import { fingerprintCutHuntWindows } from "../fingerprint-cut";
import { compareFoldFetchKey } from "../compare-fold";
import { seriesColor } from "../histogram-series";
import type { SearchResult } from "../types";
import type { HistogramSplit } from "../../query/histogram";
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
  split: HistogramSplit;
  seriesKeys: string[];
  onClose: () => void;
};

export type CompareFoldHunt = Omit<CompareFoldProps, "split" | "seriesKeys">;

type FoldRow = {
  key: string;
  before: CompareFoldSide;
  after: CompareFoldSide;
};

type Sides = {
  before: CompareFoldSide;
  after: CompareFoldSide;
  refuse: string;
  rows: FoldRow[];
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

function refuseReason(json: SearchResult): string {
  return (
    (json.scan?.source === "refused" ? json.scan.reason : "") ||
    (json.agg?.source === "refused" ? json.agg.reason ?? "" : "")
  );
}

function withSplitMatcher(
  ml: string,
  split: HistogramSplit,
  key: string,
): string {
  if (split === "none" || key === "other" || key === "events") {
    return ml;
  }
  const token = `${split}:${key}`;
  const parts = ml
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.includes(token)) {
    return ml;
  }
  return [...parts, token].join(",");
}

async function searchSide(
  fromMs: number,
  toMs: number,
  input: Pick<CompareFoldProps, "q" | "agg" | "metric" | "ml" | "split">,
  signal: AbortSignal,
): Promise<SearchResult> {
  const params = new URLSearchParams();
  params.set("from", new Date(fromMs).toISOString());
  params.set("to", new Date(toMs).toISOString());
  params.set("events", "0");
  params.set("split", input.split);
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

function emptySide(): CompareFoldSide {
  return { v: null, n: 0, empty: true, refused: false };
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
  split,
  seriesKeys,
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
  const stacked = split !== "none";
  const fetchKey = compareFoldFetchKey({
    q,
    live,
    spanMs,
    from,
    to,
    agg,
    metric,
    ml,
    split,
  });
  const [sides, setSides] = useState<Sides | null>(null);
  const [error, setError] = useState<string | null>(null);
  const plotKeysRef = useRef(seriesKeys);
  plotKeysRef.current = seriesKeys;

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
        const common = { q, agg, metric, ml, split };
        const [beforeJson, afterJson] = await Promise.all([
          searchSide(windows.beforeFrom, windows.beforeTo, common, ac.signal),
          searchSide(windows.afterFrom, windows.afterTo, common, ac.signal),
        ]);
        if (ac.signal.aborted) {
          return;
        }
        const refuse = refuseReason(beforeJson) || refuseReason(afterJson);
        const windowSec = windows.sideMs / 1000;
        const volumeKind = kind === "rate" || kind === "count";
        const keys = compareFoldRowKeys(
          split,
          compareFoldTotals(beforeJson.histogram, split),
          compareFoldTotals(afterJson.histogram, split),
          stacked ? plotKeysRef.current : undefined,
        );
        let rows: FoldRow[];
        if (!stacked) {
          rows = [
            {
              key: "events",
              before: compareFoldSideFromSearch(beforeJson, kind),
              after: compareFoldSideFromSearch(afterJson, kind),
            },
          ];
        } else if (volumeKind) {
          rows = keys.map((key) => ({
            key,
            before: compareFoldSideFromCount(
              compareFoldSeriesTotal(beforeJson.histogram, key, split),
              kind,
              windowSec,
              Boolean(refuse),
            ),
            after: compareFoldSideFromCount(
              compareFoldSeriesTotal(afterJson.histogram, key, split),
              kind,
              windowSec,
              Boolean(refuse),
            ),
          }));
        } else {
          const named = keys.filter((key) => key !== "other");
          const extras = await Promise.all(
            named.map(async (key) => {
              const scoped = {
                q: setFieldToken(q, split, key),
                agg,
                metric,
                ml: metric ? withSplitMatcher(ml, split, key) : ml,
                split: "none" as const,
              };
              const [beforeKey, afterKey] = await Promise.all([
                searchSide(windows.beforeFrom, windows.beforeTo, scoped, ac.signal),
                searchSide(windows.afterFrom, windows.afterTo, scoped, ac.signal),
              ]);
              return {
                key,
                before: compareFoldSideFromSearch(beforeKey, kind),
                after: compareFoldSideFromSearch(afterKey, kind),
              };
            }),
          );
          if (ac.signal.aborted) {
            return;
          }
          rows = extras;
          if (keys.includes("other")) {
            rows.push({
              key: "other",
              before: emptySide(),
              after: emptySide(),
            });
          }
        }
        const before = rows[0]?.before ?? compareFoldSideFromSearch(beforeJson, kind);
        const after = rows[0]?.after ?? compareFoldSideFromSearch(afterJson, kind);
        setSides({ before, after, refuse, rows });
      } catch (err) {
        if (ac.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
          return;
        }
        setError(err instanceof Error ? err.message : "Compare failed");
      }
    })();
    return () => ac.abort();
  }, [
    mark.id,
    openedAt,
    fetchKey,
    windows.dead,
    windows.beforeFrom,
    windows.beforeTo,
    windows.afterFrom,
    windows.afterTo,
    windows.sideMs,
    q,
    agg,
    metric,
    ml,
    kind,
    split,
    stacked,
  ]);

  const nowMs = Date.now();
  const frozen =
    live && !windows.banded && !windows.dead && nowMs - windows.afterTo > 1000;
  const before = sides?.before ?? emptySide();
  const after = sides?.after ?? emptySide();
  const loaded = sides != null;
  const rows = sides?.rows ?? [];
  const bothEmpty =
    loaded &&
    kind !== "metric" &&
    rows.length > 0 &&
    rows.every((row) => row.before.empty && row.after.empty) &&
    !windows.dead;
  const showStack = stacked && loaded && !windows.dead && !bothEmpty;
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
          (bothEmpty || !showStack
            ? compareFoldNote({
                windows,
                kind,
                before,
                after,
                formatDuration: formatFingerprintCutDuration,
              })
            : "")
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
      className={cn(
        "mt-1.5 mr-2.5 ml-[47px] min-w-0 shrink-0 overflow-hidden rounded-[4.4px] border bg-[#0f0f11]",
        showStack ? "flex flex-col" : "flex h-[30px] items-center gap-[7px] pr-1 pl-2.5",
      )}
      style={{ borderColor: "oklch(0.906 0.014 84 / 28%)" }}
    >
      {showStack ? (
        <>
          <div className="flex h-[30px] min-w-0 items-center gap-[7px] pr-1 pl-2.5">
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
              split
            </span>
            <span className="font-mono text-[11.5px] whitespace-nowrap tabular-nums">
              {split}
            </span>
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
            <DismissFold onClose={onClose} />
          </div>
          {rows.map((row, i) => (
            <StackRow
              key={row.key}
              rowKey={row.key}
              color={seriesColor(row.key, split, i)}
              kind={kind}
              windows={windows}
              loaded={loaded}
              before={row.before}
              after={row.after}
              formatCount={formatCount}
            />
          ))}
        </>
      ) : (
        <>
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
            <PercentChip value={formatCompareFoldPercent(pct)} />
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
          <DismissFold onClose={onClose} />
        </>
      )}
    </div>
  );
}

function DismissFold({ onClose }: { onClose: () => void }) {
  return (
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
  );
}

function PercentChip({ value }: { value: string }) {
  return (
    <span
      className="inline-flex h-[18px] shrink-0 items-center rounded-[3.4px] border px-1.5 font-mono text-[11px] whitespace-nowrap"
      style={{
        borderColor: "oklch(0.906 0.014 84 / 35%)",
        color: "oklch(0.906 0.014 84)",
      }}
    >
      {value}
    </span>
  );
}

function StackRow({
  rowKey,
  color,
  kind,
  windows,
  loaded,
  before,
  after,
  formatCount,
}: {
  rowKey: string;
  color: string;
  kind: CompareFoldKind;
  windows: ReturnType<typeof fingerprintCutHuntWindows>;
  loaded: boolean;
  before: CompareFoldSide;
  after: CompareFoldSide;
  formatCount: (n: number) => string;
}) {
  const showDelta = loaded && compareFoldShowDelta(windows, kind, before, after);
  const delta = showDelta ? (after.v ?? 0) - (before.v ?? 0) : null;
  const pct =
    showDelta && !before.empty
      ? compareFoldPercent(before.v ?? 0, after.v ?? 0)
      : null;
  const rowNote = loaded
    ? compareFoldNote({
        windows,
        kind,
        before,
        after,
        formatDuration: formatFingerprintCutDuration,
      })
    : "";
  return (
    <div className="flex h-[30px] min-w-0 items-center gap-[7px] border-t border-white/[0.07] px-2.5">
      <span
        className="size-2 shrink-0 rounded-[2px]"
        style={{ background: color }}
      />
      <span className="w-[112px] shrink-0 truncate font-mono text-[11.5px] whitespace-nowrap">
        {rowKey}
      </span>
      <span className="w-[52px] shrink-0 text-right font-mono text-[11.5px] whitespace-nowrap tabular-nums">
        {loaded ? formatSide(kind, before, formatCount) : "—"}
      </span>
      <span className="text-[10.5px] text-muted-foreground whitespace-nowrap">
        →
      </span>
      <span className="w-[52px] shrink-0 text-right font-mono text-[11.5px] whitespace-nowrap tabular-nums">
        {loaded ? formatSide(kind, after, formatCount) : "—"}
      </span>
      <span className="font-mono text-[11px] text-muted-foreground/45">·</span>
      <span className="w-[58px] shrink-0 text-right font-mono text-[11.5px] whitespace-nowrap tabular-nums">
        {showDelta && delta != null ? formatAbs(kind, delta, formatCount) : "—"}
      </span>
      {pct != null ? (
        <PercentChip value={formatCompareFoldPercent(pct)} />
      ) : (
        <span
          className="inline-flex h-[18px] min-w-[56px] shrink-0 items-center justify-center rounded-[3.4px] border px-1.5 font-mono text-[11px] whitespace-nowrap text-muted-foreground"
          style={{ borderColor: "transparent" }}
        >
          —
        </span>
      )}
      {rowNote ? (
        <>
          <span className="shrink-0 text-[10.5px] text-amber-400">▲</span>
          <span className="min-w-0 truncate text-[10.5px] whitespace-nowrap text-[oklch(0.906_0.014_84_/_90%)]">
            {rowNote}
          </span>
        </>
      ) : null}
      <span className="min-w-2 flex-1" />
    </div>
  );
}
