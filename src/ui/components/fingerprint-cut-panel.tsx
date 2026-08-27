import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { CountText } from "@/components/count-text";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatChangeMarkLabel, type ChangeMark } from "../../shared/change-mark";
import { fingerprintAttr } from "../../shared/fingerprint";
import {
  fingerprintCutNotes,
  type FingerprintCutResult,
  type FingerprintCutRow,
  type FingerprintCutSet,
} from "../../shared/fingerprint-cut";
import { isoFromLocal } from "../search-url";
import { facetValues } from "../query-tokens";
import {
  fingerprintCutFetchKey,
  fingerprintCutHuntWindows,
  formatCutWindowLines,
} from "../fingerprint-cut";
import { MarkGlyph } from "./histogram-marks";

const foot =
  "A clock cut, not causation — first seen after is not caused by. The hunt is untouched: q and facets stay; only Filter writes the bar.";

type Props = {
  mark: ChangeMark;
  openedAt: string;
  q: string;
  range: string;
  from: string;
  to: string;
  live: boolean;
  spanMs: number;
  fromMs: number;
  toMs: number;
  result: FingerprintCutResult | null;
  onResult: (result: FingerprintCutResult) => void;
  onClose: () => void;
  onFilter: (hex: string) => void;
};

export function FingerprintCutPanel({
  mark,
  openedAt,
  q,
  range,
  from,
  to,
  live,
  spanMs,
  fromMs,
  toMs,
  result,
  onResult,
  onClose,
  onFilter,
}: Props) {
  const [error, setError] = useState<string | null>(null);
  const huntToMs = Number.isFinite(toMs) ? toMs : fromMs + spanMs;
  const windows = fingerprintCutHuntWindows(mark, openedAt, fromMs, huntToMs);
  const nowMs = Date.now();
  const notes = result?.notes?.length
    ? result.notes
    : fingerprintCutNotes(windows, { live, now: nowMs });
  const lines = formatCutWindowLines(windows, nowMs);
  const fetchKey = fingerprintCutFetchKey({ q, live, spanMs, from, to });

  useEffect(() => {
    const ac = new AbortController();
    const params = new URLSearchParams();
    params.set("mark", mark.id);
    params.set("opened", openedAt);
    if (live) {
      params.set("live", "1");
    }
    if (range !== "custom") {
      params.set("range", range);
    } else {
      const fromIso = isoFromLocal(from);
      const toIso = isoFromLocal(to);
      if (fromIso) {
        params.set("from", fromIso);
      }
      if (toIso) {
        params.set("to", toIso);
      }
    }
    const qVal = q.trim();
    if (qVal) {
      params.set("q", qVal);
    }
    setError(null);
    void (async () => {
      try {
        const res = await fetch(`/api/search/cut?${params.toString()}`, {
          signal: ac.signal,
        });
        if (res.status === 401) {
          throw new Error("Unauthorized. Sign in with basic auth.");
        }
        const json = (await res.json()) as FingerprintCutResult & {
          error?: string;
        };
        if (ac.signal.aborted) {
          return;
        }
        if (!res.ok) {
          throw new Error(json.error ?? `Cut failed (${res.status})`);
        }
        onResult(json);
      } catch (err) {
        if (ac.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
          return;
        }
        setError(err instanceof Error ? err.message : "Cut failed");
      }
    })();
    return () => ac.abort();
  }, [mark.id, openedAt, fetchKey, live, range, from, to, q, onResult]);

  const sets = result?.sets ?? [];
  const emptyAll = error ?? result?.empty ?? "";

  return (
    <aside className="flex w-[398px] max-w-[36%] shrink-0 flex-col border-l bg-[#0f0f11]">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-2.5">
        <MarkGlyph kind={mark.kind} size={12} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">
          {result?.title ?? formatChangeMarkLabel(mark)}
        </span>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          title="Close — the rail returns to the event detail"
          onClick={onClose}
        >
          <X className="size-[13px]" />
        </Button>
      </div>
      <div className="flex shrink-0 flex-col gap-0.5 border-b px-2.5 py-2">
        {lines.map((row) => (
          <div key={row.k} className="flex gap-2">
            <span className="w-[52px] shrink-0 font-mono text-[10.5px] text-muted-foreground/75">
              {row.k}
            </span>
            <span className="font-mono text-[11px] text-foreground/88 whitespace-nowrap">
              {row.v}
            </span>
          </div>
        ))}
        {notes.map((note) => (
          <div
            key={note}
            className="mt-0.5 flex gap-1.5 text-[10.5px] leading-snug"
          >
            <span className="shrink-0 text-amber-400">▲</span>
            <span className="text-pretty text-amber-200/90">{note}</span>
          </div>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {sets.map((set) => (
          <CutSet
            key={set.id}
            set={set}
            q={q}
            onFilter={onFilter}
          />
        ))}
        {emptyAll ? (
          <div className="px-3 py-3.5 text-[12px] leading-relaxed text-pretty text-muted-foreground">
            {emptyAll}
          </div>
        ) : null}
      </div>
      <div className="shrink-0 border-t bg-card/45 px-2.5 py-2">
        <p className="text-[10.5px] leading-snug text-pretty text-muted-foreground/80">
          {foot}
        </p>
      </div>
    </aside>
  );
}

function CutSet({
  set,
  q,
  onFilter,
}: {
  set: FingerprintCutSet;
  q: string;
  onFilter: (hex: string) => void;
}) {
  return (
    <div>
      <div className="flex items-baseline gap-1.5 px-2.5 pt-2.5 pb-1">
        <span className="text-[11px] font-semibold tracking-wide uppercase">
          {set.name}
        </span>
        <span className="font-mono text-[10.5px] text-muted-foreground">
          {set.count}
        </span>
        <span className="ml-auto min-w-0 truncate text-[10px] text-muted-foreground/65">
          {set.def}
        </span>
      </div>
      {set.rows.map((row) => (
        <CutRow key={row.hex} row={row} q={q} onFilter={onFilter} />
      ))}
      {set.rows.length === 0 ? (
        <div className="px-2.5 pt-0.5 pb-2 text-[11px] text-muted-foreground/60">
          none
        </div>
      ) : null}
      {set.more > 0 ? (
        <div className="px-2.5 pt-1.5 pb-2 font-mono text-[10.5px] text-muted-foreground">
          +{set.more} more — capped at 10 a set; narrow the hunt to reach them
        </div>
      ) : null}
    </div>
  );
}

function CutRow({
  row,
  q,
  onFilter,
}: {
  row: FingerprintCutRow;
  q: string;
  onFilter: (hex: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const values = facetValues(q, fingerprintAttr);
  const filtered =
    values.length === 1 && values[0]!.toLowerCase() === row.hex.toLowerCase();
  const token = `${fingerprintAttr}:${row.hex}`;

  return (
    <div
      className={cn(
        "flex flex-col gap-0.5 border-b border-white/[0.06] px-2.5 py-1.5",
        filtered && "bg-accent/45 shadow-[inset_2px_0_0_oklch(0.906_0.014_84)]",
      )}
    >
      <div className="flex items-center gap-1.5">
        {row.level === "fatal" ? (
          <span className="shrink-0 rounded-[2.4px] bg-destructive/45 px-1 text-[9.5px] leading-[15px] uppercase text-red-300">
            fatal
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground/90">
          {row.message}
        </span>
        <span
          title="events before → after, equal windows"
          className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums"
        >
          <CountText n={row.before} />
          {" → "}
          <CountText n={row.after} />
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          title="Copy e1 token"
          className="-ml-1.5 flex h-[18px] shrink-0 items-center gap-1 rounded-[3.4px] px-1.5 font-mono text-[10.5px] text-amber-200/85 hover:bg-accent hover:text-amber-200"
          onClick={() => {
            void navigator.clipboard.writeText(token).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {token}
          {copied ? <span className="text-green-400">✓</span> : null}
        </button>
        <span className="font-mono text-[10.5px] text-muted-foreground">
          {row.service}
        </span>
        {row.extra ? (
          <span className="font-mono text-[10.5px] text-muted-foreground/70">
            {row.extra}
          </span>
        ) : null}
        <span className="flex-1" />
        <button
          type="button"
          title={
            filtered
              ? "Remove e1 from the bar"
              : "Write e1:<hex> into the bar — the same token an operator could type"
          }
          className={cn(
            "flex h-5 shrink-0 items-center rounded-[3.4px] border px-[7px] text-[10.5px]",
            filtered
              ? "border-amber-400/55 bg-amber-400/12 text-amber-400"
              : "border-white/15 text-foreground",
          )}
          onClick={() => onFilter(row.hex)}
        >
          {filtered ? "Filtered" : "Filter"}
        </button>
      </div>
    </div>
  );
}
