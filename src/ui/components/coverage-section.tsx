import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  COVERAGE_COMPLETE,
  COVERAGE_GAPS_SHOWN,
  coverageGaps,
  coverageGroups,
  doneSummary,
  namesSummary,
  coveragePercent,
  evidenceDocUrl,
  gapShare,
  keysDocUrl,
  marksDocUrl,
  stackDocUrl,
  type AcceptedGap,
  type CoverageKey,
  type GapKey,
  mismatchOn,
  mismatchSo,
  namesDocUrl,
  type Coverage,
  type CoverageMismatch,
  type CoverageService,
} from "../../shared/coverage";
import { formatCompactCount } from "../count-format";
import { hhmmUtc } from "../home-since";

/**
 * Coverage is a 24 h answer, read once for the page and again every five minutes while something
 * shows it. Fields, Home, the event panel and the Compare fold share the one copy, so an accept on
 * Fields is what they all read next.
 */
let shared: Coverage | null = null;
let readAt = 0;
let reading: Promise<void> | null = null;
const listeners = new Set<() => void>();

export function setCoverage(next: Coverage): void {
  shared = next;
  readAt = Date.now();
  for (const l of listeners) {
    l();
  }
}

function readShared(): Promise<void> {
  reading ??= fetch("/api/coverage")
    .then(async (res) => {
      if (res.ok) {
        setCoverage((await res.json()) as Coverage);
      }
    })
    .catch(() => {
      // a failed read keeps the last one; nothing on the page depends on it
    })
    .finally(() => {
      reading = null;
    });
  return reading;
}

export function useCoverage(): Coverage | null {
  const [data, setData] = useState<Coverage | null>(shared);
  useEffect(() => {
    const on = () => setData(shared);
    listeners.add(on);
    if (Date.now() - readAt > 300_000) {
      void readShared();
    }
    const t = setInterval(() => void readShared(), 300_000);
    return () => {
      listeners.delete(on);
      clearInterval(t);
    };
  }, []);
  return data;
}

/** Home lists this many gaps at most (37s). */
const HOME_GAP_LINES = 3;

const coverageGrid = "grid grid-cols-[160px_100px_repeat(4,minmax(0,1fr))_150px] items-center";
const namesGrid = "grid grid-cols-[230px_230px_minmax(0,1fr)_140px] gap-3";
const link = "text-sm text-zinc-300 no-underline hover:text-foreground";

const keyLabel: Record<GapKey, string> = { version: "version", host: "host", trace_id: "trace_id", stack: "stack on errors", marks: "deploy marks" };
const howToSend: Record<GapKey, string> = {
  version: keysDocUrl,
  host: keysDocUrl,
  trace_id: keysDocUrl,
  stack: stackDocUrl,
  marks: marksDocUrl,
};

/** "trace_id on auth · 12% of rows" (37n). */
function gapTitle(s: CoverageService, key: GapKey) {
  const v = gapShare(s, key) ?? 0;
  return (
    <>
      <span className="font-mono">{key === "stack" ? "a stack" : key === "marks" ? "a deploy mark" : key}</span> on <span className="font-mono">{s.service}</span>
      {key === "marks" ? " · none in 24 h" : key === "stack" ? ` · ${coveragePercent(v)} of errors` : ` · ${coveragePercent(v)} of rows`}
    </>
  );
}

type GapActions = {
  /** An Operator may accept and undo; a Viewer reads the same table. */
  canAccept: boolean;
  onAccept: (service: string, key: GapKey) => Promise<void>;
  onUndo: (service: string, key: GapKey) => Promise<void>;
};

function Bar({ v, low }: { v: number | null; low: boolean }) {
  return (
    <span className="inline-block h-1 w-11 shrink-0 overflow-hidden rounded-sm bg-white/[0.08]">
      {v === null ? null : <span className={cn("block h-1", low ? "bg-plate" : "bg-white/[0.28]")} style={{ width: `${Math.round(v * 100)}%` }} />}
    </span>
  );
}

/** One cell: a share, a gap an Operator can click (37n), or an accepted gap. */
function Cell({ s, k, actions }: { s: CoverageService; k: CoverageKey; actions: GapActions }) {
  const v = s[k];
  const accepted = s.accepted?.includes(k) ?? false;
  if (v === null) {
    return (
      <span className="flex items-center gap-2">
        <Bar v={null} low={false} />
        <span className="text-muted-foreground">—</span>
      </span>
    );
  }
  const low = v < 0.5 && !accepted;
  const body = (
    <>
      <Bar v={v} low={low} />
      <span className={low ? "text-foreground" : "text-muted-foreground"}>{coveragePercent(v)}</span>
    </>
  );
  if (accepted) {
    return (
      <span className="flex items-center gap-2">
        {body}
        <span className="font-sans text-xs leading-tight text-muted-foreground">
          accepted
          {actions.canAccept ? (
            <>
              {" · "}
              <button type="button" className="hover:text-foreground" onClick={() => void actions.onUndo(s.service, k)}>
                undo
              </button>
            </>
          ) : null}
        </span>
      </span>
    );
  }
  if (v >= COVERAGE_COMPLETE) {
    return <span className="flex items-center gap-2">{body}</span>;
  }
  return <GapPopover s={s} k={k} actions={actions} trigger={body} />;
}

function GapPopover({ s, k, actions, trigger, className }: { s: CoverageService; k: GapKey; actions: GapActions; trigger: React.ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn("-mx-1.5 flex w-fit items-center gap-2 rounded-md px-1.5 py-0.5 text-left hover:bg-white/[0.06]", open && "bg-white/[0.08]", className)}
        >
          {trigger}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[400px] border-white/10 bg-overlay p-4 font-sans">
        <div className="flex flex-col gap-2">
          <span className="text-sm">{gapTitle(s, k)}</span>
          <span className="text-sm leading-[1.5] text-zinc-400">
            Accept it when {s.service} is not meant to send it. Home and the counts stop naming it; this cell keeps its number, marked accepted.
          </span>
          <div className="flex items-center gap-2">
            {actions.canAccept ? (
              <button
                type="button"
                disabled={busy}
                className="h-8 rounded-md bg-plate px-3 text-sm font-medium text-[#09090b] disabled:opacity-60"
                onClick={async () => {
                  setBusy(true);
                  try {
                    await actions.onAccept(s.service, k);
                    setOpen(false);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Accept this gap
              </button>
            ) : null}
            <a href={howToSend[k]} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center rounded-md border border-white/15 px-3 text-sm text-foreground no-underline hover:bg-white/[0.04]">
              How to send it ↗
            </a>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function marksText(s: CoverageService): string {
  if (s.marks.count === 0 || !s.marks.last) {
    return "none in 24 h";
  }
  return s.marks.count === 1 ? `1 · ${hhmmUtc(s.marks.last)}` : `${s.marks.count} · last ${hhmmUtc(s.marks.last)}`;
}

function MarksCell({ s, actions }: { s: CoverageService; actions: GapActions }) {
  if (s.marks.count > 0) {
    return <span className="text-muted-foreground">{marksText(s)}</span>;
  }
  if (s.accepted?.includes("marks")) {
    return (
      <span className="flex items-center gap-2 text-muted-foreground">
        {marksText(s)}
        <span className="font-sans text-xs leading-tight">
          accepted
          {actions.canAccept ? (
            <>
              {" · "}
              <button type="button" className="hover:text-foreground" onClick={() => void actions.onUndo(s.service, "marks")}>
                undo
              </button>
            </>
          ) : null}
        </span>
      </span>
    );
  }
  return <GapPopover s={s} k="marks" actions={actions} trigger={<span className="text-foreground">{marksText(s)}</span>} />;
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

/** Which Coverage groups are open in this browser (37r); nothing of it is in the URL. */
type OpenGroups = { gaps: boolean; done: boolean; names: boolean };
const openKey = "toposcope.coverageOpen";

function readOpen(): OpenGroups {
  try {
    const raw = JSON.parse(localStorage.getItem(openKey) ?? "{}") as Partial<OpenGroups>;
    return { gaps: raw.gaps === true, done: raw.done === true, names: raw.names === true };
  } catch {
    return { gaps: false, done: false, names: false };
  }
}

function writeOpen(next: OpenGroups): void {
  try {
    localStorage.setItem(openKey, JSON.stringify(next));
  } catch {
    // a private window: the groups stay open for the page
  }
}

const headRow = `${coverageGrid} border-y border-t-white/[0.05] border-b-white/[0.08] px-4 py-1.5 text-xs tracking-[0.04em] text-muted-foreground uppercase`;
const foldLine = "flex w-full items-baseline gap-1.5 border-b border-white/[0.05] px-4 py-2.5 text-left text-sm hover:bg-white/[0.02]";

function ServiceRow({ s, actions }: { s: CoverageService; actions: GapActions }) {
  return (
    <div className={`${coverageGrid} border-b border-white/[0.05] px-4 py-2 font-mono text-sm`}>
      <span className="truncate">{s.service}</span>
      <span className="text-muted-foreground">{formatCompactCount(s.rows)}</span>
      <Cell s={s} k="version" actions={actions} />
      <Cell s={s} k="host" actions={actions} />
      <Cell s={s} k="trace_id" actions={actions} />
      <Cell s={s} k="stack" actions={actions} />
      <MarksCell s={s} actions={actions} />
    </div>
  );
}

/**
 * Settings › Fields, above the keys (37j, 37q): services with gaps first, largest first, 8 of them;
 * the rest, the complete or accepted, and the names that do not match fold into a line each.
 * Find a service (37r) searches every group, folded or not.
 */
export function CoverageSection({ coverage, focusNames, canAccept = false }: { coverage: Coverage | null; focusNames?: boolean; canAccept?: boolean }) {
  const namesRef = useRef<HTMLDivElement | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [find, setFind] = useState("");
  const [open, setOpenState] = useState<OpenGroups>(() => readOpen());
  const setOpen = (patch: Partial<OpenGroups>) => {
    const next = { ...open, ...patch };
    setOpenState(next);
    writeOpen(next);
  };
  const write = async (method: "POST" | "DELETE", service: string, key: GapKey) => {
    const res =
      method === "POST"
        ? await fetch("/api/coverage/accepted", { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ service, key }) })
        : await fetch(`/api/coverage/accepted?${new URLSearchParams({ service, key }).toString()}`, { method });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(body?.error ?? `Coverage answered ${res.status}`);
      return;
    }
    setCoverage((await res.json()) as Coverage);
  };
  const actions: GapActions = { canAccept, onAccept: (svc, key) => write("POST", svc, key), onUndo: (svc, key) => write("DELETE", svc, key) };
  const hasNames = (coverage?.mismatches.length ?? 0) > 0;
  // Home's "Names that do not match ›" opens them
  useEffect(() => {
    if (focusNames && hasNames) {
      setOpenState((cur) => ({ ...cur, names: true }));
      setFind("");
      requestAnimationFrame(() => namesRef.current?.scrollIntoView({ block: "start" }));
    }
  }, [focusNames, hasNames]);
  if (!coverage || coverage.services.length === 0) {
    return null;
  }
  const accepted = coverage.accepted ?? [];
  const finding = find.trim() !== "";
  const all = coverageGroups(coverage);
  const { gaps, done } = coverageGroups(coverage, find);
  const shownGaps = finding || open.gaps ? gaps : gaps.slice(0, COVERAGE_GAPS_SHOWN);
  const hidden = gaps.slice(COVERAGE_GAPS_SHOWN);
  const smallest = hidden[hidden.length - 1];
  const doneHead = (
    <div className={headRow}>
      <span className="col-span-7">Complete or accepted · {done.length}</span>
    </div>
  );
  return (
    <section aria-label="Coverage" className="mb-3.5 overflow-hidden rounded-xl border border-white/10 bg-surface-2">
      <div className="flex flex-wrap items-center gap-3 px-4 pt-2.5 pb-2">
        <h2 className="m-0 text-base font-medium">Coverage</h2>
        <span className="text-sm text-muted-foreground">
          {finding ? (
            <>
              {gaps.length + done.length} of {coverage.services.length} services match <span className="text-foreground">{find.trim()}</span>
            </>
          ) : (
            <>
              {coverage.services.length} services · {all.gaps.length} with gaps · {all.done.length} complete or accepted
              {accepted.length > 0 ? " · " : ""}
              {accepted.length > 0 ? (
                <button type="button" aria-expanded={listOpen} className="text-foreground underline underline-offset-[3px] hover:text-white" onClick={() => setListOpen(!listOpen)}>
                  {acceptedText(accepted)}
                </button>
              ) : null}
            </>
          )}
        </span>
        <span className="flex-1" />
        <a href={evidenceDocUrl} target="_blank" rel="noreferrer" className={link}>
          What an investigation reads ↗
        </a>
        {/* The label, its field and Clear wrap as one, so a narrow head never parts them. */}
        <span className="flex items-center gap-3">
          <label htmlFor="coverage-find" className="text-sm text-muted-foreground">
            Find a service
          </label>
          <input
            id="coverage-find"
            value={find}
            placeholder="name"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setFind(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && find) {
                e.stopPropagation();
                setFind("");
              }
            }}
            className="h-[30px] w-[210px] rounded-md border border-white/10 bg-surface-1 px-2.5 text-sm outline-none focus-visible:border-foreground/40"
          />
          {finding ? (
            <button type="button" className="h-[30px] rounded-md border border-white/15 px-2.5 text-sm hover:bg-white/[0.04]" onClick={() => setFind("")}>
              Clear
            </button>
          ) : null}
        </span>
      </div>
      {gaps.length > 0 ? (
        <>
          <div className={headRow}>
            <span>With gaps · {gaps.length}</span>
            <span>Rows</span>
            <span>version</span>
            <span>host</span>
            <span>trace_id</span>
            <span>stack on errors</span>
            <span>Deploy marks</span>
          </div>
          {shownGaps.map((s) => (
            <ServiceRow key={s.service} s={s} actions={actions} />
          ))}
        </>
      ) : (
        <div className={headRow}>
          <span>{finding ? "With gaps · 0" : "Service"}</span>
          <span>Rows</span>
          <span>version</span>
          <span>host</span>
          <span>trace_id</span>
          <span>stack on errors</span>
          <span>Deploy marks</span>
        </div>
      )}
      {!finding && hidden.length > 0 ? (
        <button type="button" aria-expanded={open.gaps} className={foldLine} onClick={() => setOpen({ gaps: !open.gaps })}>
          {open.gaps ? (
            <span className="text-zinc-300">{gaps.length} with gaps, all shown</span>
          ) : (
            <>
              <span className="text-zinc-300">{hidden.length} more with gaps, smaller first</span>
              <span className="text-muted-foreground">
                · the smallest has {smallest ? formatCompactCount(smallest.rows) : 0} {smallest?.rows === 1 ? "row" : "rows"}
              </span>
            </>
          )}
          <span className="flex-1" />
          <span className="text-zinc-300">{open.gaps ? "Show fewer" : "Show all"}</span>
        </button>
      ) : null}
      {finding ? (
        done.length > 0 ? (
          <>
            {doneHead}
            {done.map((s) => (
              <ServiceRow key={s.service} s={s} actions={actions} />
            ))}
          </>
        ) : null
      ) : done.length > 0 ? (
        open.done ? (
          <>
            <button type="button" aria-expanded className={cn(headRow, "w-full text-left")} onClick={() => setOpen({ done: false })}>
              <span className="col-span-6">Complete or accepted · {done.length}</span>
              <span className="text-right normal-case tracking-normal text-sm text-zinc-300">Hide</span>
            </button>
            {done.map((s) => (
              <ServiceRow key={s.service} s={s} actions={actions} />
            ))}
          </>
        ) : (
          <button type="button" aria-expanded={false} className={foldLine} onClick={() => setOpen({ done: true })}>
            <span className="text-muted-foreground">Complete or accepted · {done.length}</span>
            <span className="min-w-0 truncate text-muted-foreground">· {doneSummary(done)}</span>
            <span className="flex-1" />
            <span className="text-zinc-300">Show</span>
          </button>
        )
      ) : null}
      {!finding ? (
        <p className="m-0 border-b border-white/[0.05] px-4 py-2.5 text-xs leading-[1.5] text-muted-foreground">
          A key is complete at {Math.round(COVERAGE_COMPLETE * 100)}% of the service's rows.
          {coverage.services.some((s) => s.trace_id === null) ? (
            <>
              {" "}
              <span className="font-mono">—</span> under trace_id: the service sends no spans, so it is not counted.
            </>
          ) : null}
        </p>
      ) : null}
      {!finding && listOpen && accepted.length > 0 ? <AcceptedList accepted={accepted} actions={actions} /> : null}
      {!finding && hasNames ? (
        <div ref={namesRef} id="coverage-names" className="scroll-mt-4">
          <button type="button" aria-expanded={open.names} className={cn(foldLine, "items-baseline gap-3 border-b-0")} onClick={() => setOpen({ names: !open.names })}>
            <span className="text-sm font-medium text-foreground">Names that do not match</span>
            <span className="font-mono text-sm text-foreground">{coverage.mismatches.length}</span>
            <span className="min-w-0 truncate text-sm text-muted-foreground">
              {open.names ? "the same thing under two names, so the two sides never join" : namesSummary(coverage.mismatches)}
            </span>
            <span className="flex-1" />
            <span className="text-zinc-300">{open.names ? "Hide" : "Show"}</span>
          </button>
          {open.names ? (
            <>
              <div className={`${namesGrid} border-y border-t-white/[0.05] border-b-white/[0.08] px-4 py-1.5 text-xs tracking-[0.04em] text-muted-foreground uppercase`}>
                <span>One side says</span>
                <span>The other says</span>
                <span>So</span>
                <span />
              </div>
              {coverage.mismatches.map((m) => {
                const a = sideA(m);
                const b = sideB(m);
                return (
                  <div key={`${m.kind}:${a.name}:${b.name}`} className={`${namesGrid} items-baseline border-b border-white/[0.05] px-4 py-2.5 text-sm`}>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate font-mono">{a.name}</span>
                      <span className="text-xs text-muted-foreground">{a.on}</span>
                    </span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate font-mono">{b.name}</span>
                      <span className="text-xs text-muted-foreground">{b.on}</span>
                    </span>
                    <span className="leading-[1.45] text-zinc-300">{mismatchSo(m)}</span>
                    <a href={namesDocUrl} target="_blank" rel="noreferrer" className={cn(link, "text-right")}>
                      Fix at the source ↗
                    </a>
                  </div>
                );
              })}
              <p className="m-0 px-4 pt-2.5 pb-3 text-xs leading-[1.5] text-muted-foreground">
                Listed when one name is the other with a <span className="font-mono">v</span>, a case, or an <span className="font-mono">-api</span> /{" "}
                <span className="font-mono">-svc</span> suffix more or less. Stored rows keep their names; a fix applies from the next row on.
              </p>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** "2 gaps accepted · 1 came back" (37o). */
function acceptedText(accepted: AcceptedGap[]): string {
  const holds = accepted.filter((a) => a.state === "holds").length;
  const back = accepted.length - holds;
  const parts = [`${holds} ${holds === 1 ? "gap" : "gaps"} accepted`];
  if (back > 0) {
    parts.push(`${back} came back`);
  }
  return parts.join(" · ");
}

/** "today, 14:40" or "28 Oct", in UTC as the rest of the page. */
function acceptedWhen(at: number, now = Date.now()): string {
  const d = new Date(at);
  if (d.toISOString().slice(0, 10) === new Date(now).toISOString().slice(0, 10)) {
    return `today, ${hhmmUtc(d.toISOString())}`;
  }
  return `${d.getUTCDate()} ${d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })}`;
}

/** "12% of its rows had trace_id when marked" (37o). */
function acceptedThen(a: AcceptedGap): string {
  if (a.key === "marks") {
    return "no deploy mark in 24 h when marked";
  }
  if (a.key === "stack") {
    return `${coveragePercent(a.share)} of its errors had a stack when marked`;
  }
  return `${coveragePercent(a.share)} of its rows had ${a.key} when marked`;
}

function AcceptedList({ accepted, actions }: { accepted: AcceptedGap[]; actions: GapActions }) {
  const grid = "grid grid-cols-[210px_190px_minmax(0,1fr)_minmax(0,0.9fr)_72px] gap-3";
  return (
    <div id="coverage-accepted" className="border-t border-white/[0.08]">
      <div className="flex items-baseline gap-3 px-4 pt-3 pb-2">
        <h3 className="m-0 text-sm font-medium">Accepted gaps</h3>
        <span className="font-mono text-sm text-foreground">{accepted.length}</span>
        <span className="text-sm text-muted-foreground">not counted on Home or in the totals while they hold</span>
      </div>
      <div className={`${grid} border-y border-t-white/[0.05] border-b-white/[0.08] px-4 py-1.5 text-xs tracking-[0.04em] text-muted-foreground uppercase`}>
        <span>Gap</span>
        <span>Accepted</span>
        <span>When marked · now</span>
        <span>State</span>
        <span />
      </div>
      {accepted.map((a) => {
        const back = a.state === "back";
        return (
          <div key={`${a.service}:${a.key}`} className={`${grid} items-start border-b border-white/[0.05] px-4 py-2.5 text-sm`}>
            <span className="font-mono">
              {a.service} · {keyLabel[a.key]}
            </span>
            <span className="flex flex-col gap-0.5">
              <span title={a.by_role ? `${a.by_role[0]!.toUpperCase()}${a.by_role.slice(1)}` : undefined}>{a.by ?? "—"}</span>
              <span className="text-xs text-muted-foreground">{acceptedWhen(a.at)}</span>
            </span>
            <span className="flex flex-col gap-0.5">
              <span>{acceptedThen(a)}</span>
              <span className={cn("text-xs", back ? "text-foreground" : "text-muted-foreground")}>
                {a.now === null ? "not measured now" : a.key === "marks" ? "none now" : (
                  <>
                    <span className="font-mono">{coveragePercent(a.now)}</span> now
                  </>
                )}
              </span>
            </span>
            <span className={back ? "text-foreground" : "text-muted-foreground"}>{back ? "Fell since it was accepted: counted as a gap again." : "Holds."}</span>
            {actions.canAccept ? (
              <span className="text-right">
                <button type="button" className="h-7 rounded-md border border-white/15 px-2.5 text-sm hover:bg-white/[0.04]" onClick={() => void actions.onUndo(a.service, a.key)}>
                  Undo
                </button>
              </span>
            ) : (
              <span />
            )}
          </div>
        );
      })}
      <p className="m-0 px-4 pt-2.5 pb-3 text-xs leading-[1.5] text-muted-foreground">
        An accepted gap comes back as a gap when its share falls below what it was when accepted, and is cleared when the key reaches 90%. Undo is an Operator's; every accept
        and undo records who and when.
      </p>
    </div>
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
  const withGaps = coverage.services.filter((s) => !s.complete).length;
  // 37s: three lines at most; the rest is one line to Fields
  const shown = gaps.slice(0, HOME_GAP_LINES);
  const more = withGaps - shown.filter((g) => !g.mark).length;
  return (
    <section aria-label="What this answer stands on" className="shrink-0 overflow-hidden rounded-xl border border-white/10 bg-surface-2">
      <div className="flex flex-wrap items-baseline gap-3 px-4 pt-3 pb-2">
        <h2 className="m-0 text-base font-medium">What this answer stands on</h2>
        <span className="text-sm text-muted-foreground">
          {withGaps} of {coverage.services.length} services {withGaps === 1 ? "has" : "have"} gaps
          {names > 0 ? ` · ${names} ${names === 1 ? "name does" : "names do"} not match` : ""}
        </span>
        <span className="flex-1" />
        <button type="button" className={link} onClick={() => onOpenFields(false)}>
          Coverage in Fields ›
        </button>
      </div>
      {shown.map((g) => (
        <div key={g.service} className="grid grid-cols-[120px_minmax(0,1fr)_170px] items-baseline gap-3 border-t border-white/[0.05] px-4 py-2 text-sm">
          <span className="truncate font-mono">{g.service}</span>
          <span className="text-zinc-300">{g.what}</span>
          {g.href ? (
            <a href={g.href} target="_blank" rel="noreferrer" className="text-right text-sm text-zinc-400 no-underline hover:text-foreground">
              {g.fix}
            </a>
          ) : (
            <button type="button" className="text-right text-sm text-zinc-400 hover:text-foreground" onClick={() => onOpenFields(true)}>
              {g.fix}
            </button>
          )}
        </div>
      ))}
      {more > 0 ? (
        <div className="flex items-baseline gap-3 border-t border-white/[0.05] px-4 py-2 text-sm">
          <span className="text-muted-foreground">
            and {more} more {more === 1 ? "service" : "services"} with gaps, the largest first
          </span>
          <span className="flex-1" />
          <button type="button" className={link} onClick={() => onOpenFields(false)}>
            See them in Fields ›
          </button>
        </div>
      ) : null}
    </section>
  );
}
