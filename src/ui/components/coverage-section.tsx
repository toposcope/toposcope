import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  COVERAGE_COMPLETE,
  coverageGaps,
  coverageNotes,
  coveragePercent,
  evidenceDocUrl,
  mismatchOn,
  mismatchSo,
  namesDocUrl,
  type Coverage,
  type CoverageMismatch,
  type CoverageService,
} from "../../shared/coverage";
import { formatCompactCount } from "../count-format";
import { hhmmUtc } from "../home-since";

/** Coverage is a 24 h answer: it is read once, and again every five minutes while it is open. */
export function useCoverage(): Coverage | null {
  const [data, setData] = useState<Coverage | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    const load = async () => {
      try {
        const res = await fetch("/api/coverage", { signal: ac.signal });
        if (res.ok) {
          setData((await res.json()) as Coverage);
        }
      } catch {
        // a failed read keeps the last one; nothing on the page depends on it
      }
    };
    void load();
    const t = setInterval(() => void load(), 300_000);
    return () => {
      ac.abort();
      clearInterval(t);
    };
  }, []);
  return data;
}

const coverageGrid = "grid grid-cols-[160px_100px_repeat(4,minmax(0,1fr))_150px] items-center";
const namesGrid = "grid grid-cols-[230px_230px_minmax(0,1fr)_140px] gap-3";
const link = "text-[12px] text-zinc-300 no-underline hover:text-foreground";

function Cell({ v }: { v: number | null }) {
  if (v === null) {
    return (
      <span className="flex items-center gap-2">
        <span className="inline-block h-1 w-11 rounded-sm bg-white/[0.08]" />
        <span className="text-muted-foreground">—</span>
      </span>
    );
  }
  const low = v < 0.5;
  return (
    <span className="flex items-center gap-2">
      <span className="inline-block h-1 w-11 overflow-hidden rounded-sm bg-white/[0.08]">
        <span className={cn("block h-1", low ? "bg-plate" : "bg-white/[0.28]")} style={{ width: `${Math.round(v * 100)}%` }} />
      </span>
      <span className={low ? "text-foreground" : "text-muted-foreground"}>{coveragePercent(v)}</span>
    </span>
  );
}

function marksText(s: CoverageService): string {
  if (s.marks.count === 0 || !s.marks.last) {
    return "none in 24 h";
  }
  return s.marks.count === 1 ? `1 · ${hhmmUtc(s.marks.last)}` : `${s.marks.count} · last ${hhmmUtc(s.marks.last)}`;
}

function sideA(m: CoverageMismatch): { name: string; on: string } {
  return m.kind === "service"
    ? { name: `service:${m.service}`, on: `logs · ${formatCompactCount(m.rows)} rows` }
    : { name: `version:${m.rows_value}`, on: `${m.service} rows · ${formatCompactCount(m.rows)}` };
}

function sideB(m: CoverageMismatch): { name: string; on: string } {
  return m.kind === "service"
    ? { name: `service:${m.other}`, on: mismatchOn(m, formatCompactCount) }
    : { name: m.mark_value, on: `deploy mark ▲ ${hhmmUtc(m.mark_ts)}` };
}

/** Settings › Fields, above the keys (37j): each service's share of the keys, and the names that do not match. */
export function CoverageSection({ coverage, focusNames }: { coverage: Coverage | null; focusNames?: boolean }) {
  const namesRef = useRef<HTMLDivElement | null>(null);
  const hasNames = (coverage?.mismatches.length ?? 0) > 0;
  useEffect(() => {
    if (focusNames && hasNames) {
      namesRef.current?.scrollIntoView({ block: "start" });
    }
  }, [focusNames, hasNames]);
  if (!coverage || coverage.services.length === 0) {
    return null;
  }
  const notes = coverageNotes(coverage);
  const traceNone = coverage.services.some((s) => s.trace_id === null);
  return (
    <section aria-label="Coverage" className="mb-3.5 overflow-hidden rounded-[10px] border border-white/10 bg-[#131316]">
      <div className="flex items-baseline gap-3 px-4 pt-3 pb-2">
        <h2 className="m-0 text-[13.5px] font-medium">Coverage</h2>
        <span className="text-[12px] text-muted-foreground">
          share of each service's rows that carry the key · {coverage.complete} of {coverage.services.length} complete
        </span>
        <span className="flex-1" />
        <a href={evidenceDocUrl} target="_blank" rel="noreferrer" className={link}>
          What an investigation reads ↗
        </a>
      </div>
      <div className={`${coverageGrid} border-y border-t-white/[0.05] border-b-white/[0.08] px-4 py-1.5 text-[11px] tracking-[0.04em] text-muted-foreground uppercase`}>
        <span>Service</span>
        <span>Rows</span>
        <span>version</span>
        <span>host</span>
        <span>trace_id</span>
        <span>stack on errors</span>
        <span>Deploy marks</span>
      </div>
      {coverage.services.map((s) => (
        <div key={s.service} className={`${coverageGrid} border-b border-white/[0.05] px-4 py-[9px] font-mono text-[12.5px]`}>
          <span className="truncate">{s.service}</span>
          <span className="text-muted-foreground">{formatCompactCount(s.rows)}</span>
          <Cell v={s.version} />
          <Cell v={s.host} />
          <Cell v={s.trace_id} />
          <Cell v={s.stack} />
          <span className={s.marks.count === 0 ? "text-foreground" : "text-muted-foreground"}>{marksText(s)}</span>
        </div>
      ))}
      {notes.length > 0 ? (
        <p className="m-0 px-4 pt-2.5 pb-1 text-[12px] leading-[1.5] text-zinc-400">
          {notes.map((n, i) => (
            <span key={n.service}>
              {i > 0 ? " " : ""}
              {n.kind === "version" ? (
                <>
                  {n.service} sends no <span className="font-mono text-foreground">version</span>
                  {n.noMark ? " and no deploy mark, so Home cannot say what changed on it." : ", so Home cannot tell its releases apart."}
                </>
              ) : (
                `${n.service} logs errors without a stack: ${n.missing} of them are fingerprinted from the message alone, so a reworded message reads as a new error.`
              )}
            </span>
          ))}
        </p>
      ) : null}
      <p className={cn("m-0 px-4 pb-3 text-[11.5px] leading-[1.5] text-muted-foreground", notes.length === 0 && "pt-2.5")}>
        A key is complete at {Math.round(COVERAGE_COMPLETE * 100)}% of the service's rows.
        {traceNone ? (
          <>
            {" "}
            <span className="font-mono">—</span> under trace_id: the service sends no spans, so it is not counted.
          </>
        ) : null}
      </p>
      {hasNames ? (
        <div ref={namesRef} id="coverage-names" className="scroll-mt-4 border-t border-white/[0.08]">
          <div className="flex items-baseline gap-3 px-4 pt-3 pb-2">
            <h3 className="m-0 text-[13px] font-medium">Names that do not match</h3>
            <span className="font-mono text-[12px] text-foreground">{coverage.mismatches.length}</span>
            <span className="text-[12px] text-muted-foreground">the same thing under two names, so the two sides never join</span>
          </div>
          <div className={`${namesGrid} border-y border-t-white/[0.05] border-b-white/[0.08] px-4 py-1.5 text-[11px] tracking-[0.04em] text-muted-foreground uppercase`}>
            <span>One side says</span>
            <span>The other says</span>
            <span>So</span>
            <span />
          </div>
          {coverage.mismatches.map((m) => {
            const a = sideA(m);
            const b = sideB(m);
            return (
              <div key={`${m.kind}:${a.name}:${b.name}`} className={`${namesGrid} items-baseline border-b border-white/[0.05] px-4 py-2.5 text-[12.5px]`}>
                <span className="flex min-w-0 flex-col gap-[3px]">
                  <span className="truncate font-mono">{a.name}</span>
                  <span className="text-[11.5px] text-muted-foreground">{a.on}</span>
                </span>
                <span className="flex min-w-0 flex-col gap-[3px]">
                  <span className="truncate font-mono">{b.name}</span>
                  <span className="text-[11.5px] text-muted-foreground">{b.on}</span>
                </span>
                <span className="leading-[1.45] text-zinc-300">{mismatchSo(m)}</span>
                <a href={namesDocUrl} target="_blank" rel="noreferrer" className={cn(link, "text-right")}>
                  Fix at the source ↗
                </a>
              </div>
            );
          })}
          <p className="m-0 px-4 pt-2.5 pb-3 text-[11.5px] leading-[1.5] text-muted-foreground">
            Listed when one name is the other with a <span className="font-mono">v</span>, a case, or an <span className="font-mono">-api</span> /{" "}
            <span className="font-mono">-svc</span> suffix more or less. Stored rows keep their names; a fix applies from the next row on.
          </p>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Home, under the cards (37k): what this answer stands on, gaps only. A mismatch on the selected
 * mark comes first; with nothing missing the section is not drawn.
 */
export function EvidenceGaps({
  coverage,
  selectedMarkId,
  onOpenFields,
}: {
  coverage: Coverage | null;
  selectedMarkId: string | null;
  onOpenFields: (names: boolean) => void;
}) {
  if (!coverage) {
    return null;
  }
  const gaps = coverageGaps(coverage, selectedMarkId);
  if (gaps.length === 0 && coverage.mismatches.length === 0) {
    return null;
  }
  const names = coverage.mismatches.length;
  return (
    <section aria-label="What this answer stands on" className="overflow-hidden rounded-[10px] border border-white/10 bg-[#131316]">
      <div className="flex flex-wrap items-baseline gap-3 px-4 pt-3 pb-2">
        <h2 className="m-0 text-[13.5px] font-medium">What this answer stands on</h2>
        <span className="text-[12px] text-muted-foreground">
          gaps in the last 24 h · {coverage.complete} of {coverage.services.length} services complete
          {names > 0 ? ` · ${names} ${names === 1 ? "name does" : "names do"} not match` : ""}
        </span>
        <span className="flex-1" />
        <button type="button" className={link} onClick={() => onOpenFields(false)}>
          Coverage in Fields ›
        </button>
      </div>
      {gaps.map((g) => (
        <div key={g.service} className="grid grid-cols-[120px_minmax(0,1fr)_170px] items-baseline gap-3 border-t border-white/[0.05] px-4 py-[9px] text-[12.5px]">
          <span className="truncate font-mono">{g.service}</span>
          <span className="text-zinc-300">{g.what}</span>
          {g.href ? (
            <a href={g.href} target="_blank" rel="noreferrer" className="text-right text-[12px] text-zinc-400 no-underline hover:text-foreground">
              {g.fix}
            </a>
          ) : (
            <button type="button" className="text-right text-[12px] text-zinc-400 hover:text-foreground" onClick={() => onOpenFields(true)}>
              {g.fix}
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
