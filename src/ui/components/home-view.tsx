import { ChevronDown, ChevronRight, Ellipsis } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { ChangeMark } from "../../shared/change-mark";
import type { HomeCard, HomeSince } from "../../control/home-since";
import type { GoneHost } from "../../control/gone-hosts";
import { formatCompactCount } from "../count-format";
import {
  archivedSaved,
  archivedText,
  beforeAfterWidths,
  boardCountText,
  boardPreview,
  coverageLead,
  drawsBeforeAfter,
  goneInQuiet,
  goneSince,
  goneText,
  homeBoards,
  homeHunts,
  quietNotZero,
  quietText,
  quietValue,
  sparkRows,
  splitHunts,
} from "../home-saved";
import { agoText, deltaText, fingerprintsTitle, firstRunSteps, formatValue, hhmmUtc, markGlyph, markStrip, markWhen, resolvePick, sideText, type HomePick } from "../home-since";
import type { MonitorView, SavedSearch } from "../types";
import { AgentBadge } from "./agent-badge";
import { BoardNameDialog } from "./board-name-dialog";
import { EvidenceGaps, useCoverage } from "./coverage-section";
import { pageReading } from "@/components/ui/page";

export type HomeWindow = { from: string; to: string };

type Props = {
  /** The person looking (#307). */
  meId?: string | null;
  /** A Viewer (30e): monitors are read-only, and the card says who to ask. */
  readOnly?: boolean;
  saved: SavedSearch[];
  monitors: MonitorView[];
  instanceName: string | null;
  /** Open a saved hunt on this window (the Compare fold follows with #260). */
  onOpenSaved: (item: SavedSearch, window: HomeWindow, markId: string | null) => void;
  /** Open a hunt with this `q` on this window. */
  onOpenHunt: (q: string, window: HomeWindow) => void;
  onOpenWatch: () => void;
  onOpenAccess: () => void;
  /** An agent's badge opens its row in Access (#357); absent for a Viewer, who sees no Access. */
  onOpenAgents?: () => void;
  onOpenBoard: (item: SavedSearch) => void;
  /** `＋ New board` (49b): make an empty board with this name and open it. Absent: no button. */
  onNewBoard?: (name: string) => Promise<void>;
  /** Settings › Fields, at its Coverage or at the names that do not match (37k). */
  onOpenFields?: (names: boolean) => void;
  /** A saved hunt's ⋯ menu (50c): Rename, Archive or Unarchive, Delete. Absent, or a Viewer: no menu. */
  onRenameSaved?: (item: SavedSearch, name: string) => Promise<void>;
  onArchiveSaved?: (item: SavedSearch, archived: boolean) => Promise<void>;
  /** `Archive 18` (51c): archive these saved hunts together. Absent: no Archive line. */
  onArchiveMany?: (items: SavedSearch[]) => Promise<void>;
  onDeleteSaved?: (item: SavedSearch) => Promise<void>;
};

const pickKey = "toposcope.homePick";
// 50b: Quiet starts folded; a new key, so a fold left open before sheet 50 starts folded once.
const quietKey = "toposcope.homeQuietOpen.50";

function readPick(): HomePick | null {
  try {
    const raw = localStorage.getItem(pickKey);
    return raw ? (JSON.parse(raw) as HomePick) : null;
  } catch {
    return null;
  }
}

function writePick(pick: HomePick | null): void {
  try {
    if (pick) {
      localStorage.setItem(pickKey, JSON.stringify(pick));
    } else {
      localStorage.removeItem(pickKey);
    }
  } catch {
    // a private window: the pick lasts the page
  }
}

const barButton = "h-7.5 px-3 text-sm";

export function HomeView(props: Props) {
  const [data, setData] = useState<HomeSince | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [pick, setPick] = useState<HomePick | null>(() => readPick());
  const [note, setNote] = useState<string | null>(null);
  const [newBoard, setNewBoard] = useState(false);
  const [renaming, setRenaming] = useState<SavedSearch | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [coverageOpen, setCoverageOpen] = useState(false);
  const coverage = useCoverage();
  // 35f: an opened Quiet fold stays open in this browser
  const [quietOpen, setQuietOpen] = useState(() => {
    try {
      return localStorage.getItem(quietKey) === "1";
    } catch {
      return false;
    }
  });
  const pickRef = useRef(pick);
  pickRef.current = pick;

  const load = useCallback(async (signal?: AbortSignal) => {
    const p = pickRef.current;
    const params = new URLSearchParams();
    if (p?.markId === "hour") {
      params.set("since", "hour");
    } else if (p?.markId) {
      params.set("mark", p.markId);
    }
    try {
      const res = await fetch(`/api/home/since?${params.toString()}`, { signal });
      if (!res.ok) {
        if (res.status === 404 && p) {
          // the clicked mark is gone: back to the server's own pick
          writePick(null);
          setPick(null);
          return;
        }
        throw new Error(`Home answered ${res.status}`);
      }
      const json = (await res.json()) as HomeSince;
      // a newer deploy or flag drops a remembered pick
      if (p && p.markId !== "hour") {
        if (json.since.kind === "mark" && !json.since.auto && resolvePick(p, p.autoThen, json.marks) === null) {
          writePick(null);
          setPick(null);
          return;
        }
      }
      setData(json);
      setFailed(null);
    } catch (err) {
      if (signal?.aborted) {
        return;
      }
      setFailed(err instanceof Error ? err.message : "Home could not load");
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    const t = setInterval(() => void load(), 30_000);
    return () => {
      ac.abort();
      clearInterval(t);
    };
  }, [load, pick]);

  function choose(markId: string | null) {
    if (markId === null) {
      writePick(null);
      setPick(null);
      return;
    }
    const autoThen = data?.since.kind === "mark" && data.since.auto ? data.since.mark.id : (pick?.autoThen ?? null);
    const next = { markId, autoThen };
    writePick(next);
    setPick(next);
  }

  function toggleQuiet(open: boolean) {
    setQuietOpen(open);
    try {
      localStorage.setItem(quietKey, open ? "1" : "0");
    } catch {
      // a private window: the fold lasts the page
    }
  }

  async function addNote(text: string) {
    const title = text.trim();
    if (!title) {
      return;
    }
    const res = await fetch("/v1/marks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "note", label: title }),
    });
    if (!res.ok) {
      toast.error(`The note was not written (${res.status})`);
      return;
    }
    setNote(null);
    toast.success("Note mark written at now");
    void load();
  }

  if (failed && !data) {
    return <main className="p-6 text-sm text-muted-foreground">{failed}</main>;
  }
  if (!data) {
    return <main className="p-6 text-sm text-muted-foreground">Loading…</main>;
  }
  if (!data.ingested) {
    return <FirstRun instanceName={props.instanceName} savedCount={props.saved.length} markCount={data.marks.length} onOpenAccess={props.onOpenAccess} />;
  }

  const nowMs = Date.parse(data.now);
  const since = data.since;
  const hour = since.kind === "hour";
  const selectedId = since.kind === "mark" ? since.mark.id : null;
  const strip = markStrip(data.marks, selectedId);
  const window: HomeWindow = { from: data.before.from, to: data.after.to };
  const monitors = [...props.monitors].sort((a, b) => Number(Boolean(b.open)) - Number(Boolean(a.open)));
  const openCount = monitors.filter((m) => m.open).length;
  const fp = data.fingerprints;
  const e1Query = fp ? fp.first_seen.map((r) => `e1:${r.hex}`).join(" OR ") : "";
  const hunts = homeHunts(props.saved);
  const boards = homeBoards(props.saved);
  const archived = archivedSaved(props.saved);
  const split = splitHunts(hunts, data.cards);
  const cardById = new Map(data.cards.map((c) => [c.saved_id, c]));
  const openHunt = (s: SavedSearch) => props.onOpenSaved(s, window, selectedId);
  const openAny = (s: SavedSearch) => (s.board ? props.onOpenBoard(s) : openHunt(s));
  const notZero = quietNotZero(split.quiet, data.cards);
  const coverageLine = props.onOpenFields ? coverageLead(coverage, selectedId) : null;
  const gone = goneInQuiet(split.quiet, data.gone?.saved_ids ?? []);
  const { onRenameSaved, onArchiveSaved, onDeleteSaved } = props;
  // 50c: the ⋯ menu is for whoever may change a hunt; a Viewer has none.
  const canChange = !props.readOnly && onRenameSaved && onArchiveSaved && onDeleteSaved;
  const menuFor = (item: SavedSearch) =>
    canChange ? (
      <SavedMenu
        item={item}
        onOpen={() => openAny(item)}
        onRename={() => setRenaming(item)}
        onArchive={() => void onArchiveSaved(item, true)}
        onDelete={() => void onDeleteSaved(item)}
      />
    ) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 px-6 pt-3 pb-2.5">
        <span className="mr-1 text-sm text-muted-foreground">Since</span>
        {hour ? <MarkChip on label="the last hour" time={`${hhmmUtc(data.after.from)} → ${hhmmUtc(data.after.to)}`} /> : null}
        {hour && data.marks.length === 0 ? <span className="text-sm text-muted-foreground">no mark in the last 24 h</span> : null}
        {strip.chips.map((m) => (
          <MarkChip key={m.id} on={m.id === selectedId} mark={m} label={m.title} time={markWhen(m.ts, nowMs)} onClick={() => choose(m.id)} />
        ))}
        {strip.earlier.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" className={barButton}>
                {strip.earlier.length} earlier
                <ChevronDown className="text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
              {strip.earlier.map((m) => (
                <DropdownMenuItem key={m.id} className="gap-1.5" onSelect={() => choose(m.id)}>
                  <span style={{ color: markGlyph[m.kind].color }}>{markGlyph[m.kind].glyph}</span>
                  <span className="max-w-72 truncate">{m.title}</span>
                  <span className="ml-auto pl-3 font-mono text-xs text-muted-foreground">{markWhen(m.ts, nowMs)}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <div className="flex-1" />
        {since.kind === "mark" ? (
          <Button type="button" variant="outline" className={barButton} onClick={() => choose("hour")}>
            Last hour
          </Button>
        ) : null}
        {props.readOnly ? null : note === null ? (
          <Button type="button" variant="outline" className={barButton} onClick={() => setNote("")}>
            ＋ Note
          </Button>
        ) : (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              void addNote(note);
            }}
          >
            <input
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setNote(null);
                }
              }}
              placeholder="what you did, in one line"
              aria-label="Note mark"
              className="h-7.5 w-64 rounded-lg border border-white/10 bg-surface-1 px-2.5 text-sm outline-none focus-visible:border-foreground/40"
            />
            <Button type="submit" variant="outline">
              ○ Add
            </Button>
          </form>
        )}
      </div>

      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto border-t border-white/[0.06] px-6 pt-4 pb-6">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="m-0 text-xl font-semibold tracking-[-0.01em]">
            {since.kind === "mark" ? (
              <>
                Since <span className="text-plate">{since.mark.title}</span>
              </>
            ) : (
              "The last hour, against the hour before"
            )}
          </h1>
          <span className="font-mono text-xs text-faint" title={since.kind === "mark" ? `Saved hunts read ${sideText(data.side_ms)}` : undefined}>
            {since.kind === "mark"
              ? `${markWhen(since.mark.ts, nowMs, true)} UTC · ${agoText(since.mark.ts, nowMs)}`
              : `${hhmmUtc(data.before.from)} → ${hhmmUtc(data.before.to)} · ${hhmmUtc(data.after.from)} → ${hhmmUtc(data.after.to)} · UTC`}
          </span>
          {since.kind === "mark" && !since.auto ? <span className="text-sm text-faint">· your pick, until a newer deploy or flag</span> : null}
        </div>

        <section className="mt-4" aria-labelledby="home-moved">
          <div className="flex items-baseline gap-2">
            <h2 id="home-moved" className="m-0 text-sm font-medium">
              Moved
            </h2>
            {hunts.length > 0 ? (
              <span className="text-sm text-muted-foreground">
                {split.moved.length} of {hunts.length} saved hunt{hunts.length === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>
          {hunts.length === 0 ? (
            <p className="m-0 mt-2 text-sm text-muted-foreground">Save a hunt and it shows here when it moves.</p>
          ) : split.moved.length === 0 ? (
            <p className="m-0 mt-2 text-sm text-muted-foreground">
              {since.kind === "mark" ? (
                <>
                  Nothing moved since <span className="text-foreground">{since.mark.title}</span>
                </>
              ) : (
                "Nothing moved in the last hour"
              )}
            </p>
          ) : (
            <div className="mt-2 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
              {split.moved.map(({ item, card }) => (
                <MovedCard key={item.id} card={card} name={item.name} quiet={hour} onClick={() => openHunt(item)} menu={menuFor(item)} />
              ))}
            </div>
          )}
        </section>

        <section className="mt-6" aria-labelledby="home-boards">
          <div className="flex items-center gap-2">
            <h2 id="home-boards" className="m-0 text-sm font-medium">
              Boards
            </h2>
            <span className="text-sm text-muted-foreground">{boards.length}</span>
            <div className="flex-1" />
            {props.onNewBoard && !props.readOnly ? (
              <Button type="button" variant="outline" onClick={() => setNewBoard(true)}>
                ＋ New board
              </Button>
            ) : null}
          </div>
          {boards.length > 0 ? (
            <div className="mt-2 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
              {boards.map((b) => (
                <BoardTile key={b.id} item={b} onClick={() => props.onOpenBoard(b)} />
              ))}
            </div>
          ) : null}
        </section>

        {split.quiet.length > 0 || archived.length > 0 || coverageLine ? (
          // 50b: Quiet, Archived and Coverage, each folded to one line that opens in place.
          <div className="mt-6 border-t border-white/[0.06]">
            {split.quiet.length > 0 ? (
              <section aria-label="Quiet" className="border-b border-white/[0.06]">
                <FoldLine open={quietOpen} label="Quiet" sub={quietText(split.quiet.length)} right={notZero} onToggle={() => toggleQuiet(!quietOpen)} />
                {quietOpen ? (
                  <div className="grid grid-cols-1 gap-x-6 gap-y-0.5 pb-2 text-sm md:grid-cols-2 xl:grid-cols-3">
                    {split.quiet.map((s) => (
                      <QuietRow key={s.id} item={s} value={quietValue(cardById.get(s.id))} onOpenAgents={props.onOpenAgents} onClick={() => openHunt(s)} menu={menuFor(s)} />
                    ))}
                  </div>
                ) : null}
                {gone.length > 0 && canChange && props.onArchiveMany ? (
                  <GoneLine items={gone} hosts={data.gone.hosts} onArchive={props.onArchiveMany} />
                ) : null}
              </section>
            ) : null}
            {archived.length > 0 ? (
              <section aria-label="Archived" className="border-b border-white/[0.06]">
                <FoldLine open={archivedOpen} label="Archived" sub={archivedText(archived)} onToggle={() => setArchivedOpen(!archivedOpen)} />
                {archivedOpen ? (
                  <div className="grid grid-cols-1 gap-x-6 gap-y-0.5 pb-2 text-sm md:grid-cols-2 xl:grid-cols-3">
                    {archived.map((s) => (
                      <QuietRow
                        key={s.id}
                        item={s}
                        value=""
                        onOpenAgents={props.onOpenAgents}
                        onClick={() => openAny(s)}
                        menuShown
                        menu={
                          canChange ? (
                            <Button type="button" variant="ghost" className="h-6 px-2 text-xs text-muted-foreground" onClick={() => void onArchiveSaved(s, false)}>
                              Unarchive
                            </Button>
                          ) : null
                        }
                      />
                    ))}
                  </div>
                ) : null}
              </section>
            ) : null}
            {coverageLine && props.onOpenFields ? (
              <section aria-label="Coverage" className="border-b border-white/[0.06]">
                <FoldLine
                  open={coverageOpen}
                  label="Coverage"
                  sub={coverageLine.text}
                  onToggle={() => setCoverageOpen(!coverageOpen)}
                  after={
                    <span className="flex shrink-0 items-center gap-2 text-sm">
                      {coverageLine.href ? (
                        <a href={coverageLine.href} target="_blank" rel="noreferrer" className="rounded-md text-foreground no-underline hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                          {coverageLine.fix}
                        </a>
                      ) : (
                        <button type="button" className="rounded-md text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={() => props.onOpenFields?.(true)}>
                          {coverageLine.fix}
                        </button>
                      )}
                      <span className="text-faint" aria-hidden="true">·</span>
                      <button type="button" className="rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={() => props.onOpenFields?.(false)}>
                        {coverageLine.more > 0 ? `${coverageLine.more} more in Fields ›` : "Fields ›"}
                      </button>
                    </span>
                  }
                />
                {coverageOpen ? (
                  <div className="pb-3">
                    <EvidenceGaps coverage={coverage} selectedMarkId={selectedId} onOpenFields={props.onOpenFields} />
                  </div>
                ) : null}
              </section>
            ) : null}
          </div>
        ) : null}

        <div className="mt-6 grid grid-cols-1 gap-3 lg:grid-cols-2">
          <section className="flex flex-col gap-2 rounded-xl border border-white/10 bg-surface-2 px-4 py-4">
            <div className="flex justify-between">
              <span className="text-base font-medium">{fingerprintsTitle(fp)}</span>
              {fp && fp.first_seen.length > 0 ? (
                <button type="button" className="text-sm text-muted-foreground hover:text-foreground" onClick={() => props.onOpenHunt(e1Query, data.after)}>
                  open as a hunt →
                </button>
              ) : null}
            </div>
            {fp && (fp.first_seen.length > 0 || fp.stopped.length > 0) ? (
              <>
                {fp.first_seen.slice(0, 4).map((r) => (
                  <Line key={r.hex} hex={r.hex} text={r.message} sub={r.service} n={r.count} />
                ))}
                {fp.stopped.slice(0, Math.max(0, 4 - Math.min(4, fp.first_seen.length))).map((r) => (
                  <Line key={r.hex} hex={r.hex} tag="stopped" text={r.message} sub={r.service} n={0} muted />
                ))}
              </>
            ) : (
              <p className="m-0 text-sm leading-[1.5] text-muted-foreground">
                {hour ? "Nothing new in the last hour." : "No fingerprint first seen after this mark, and none stopped."}
              </p>
            )}
          </section>
          <section className="flex flex-col gap-2 rounded-xl border border-white/10 bg-surface-2 px-4 py-4">
            <div className="flex justify-between">
              <span className="text-base font-medium">Monitors · {openCount > 0 ? `${openCount} open` : monitors.length ? "all ok" : "none"}</span>
              <button type="button" className="text-sm text-muted-foreground hover:text-foreground" onClick={props.onOpenWatch}>
                {monitors.length ? `all ${monitors.length} →` : "Watch →"}
              </button>
            </div>
            {monitors.slice(0, 4).map((m) => (
              <div key={m.id} className="flex items-start gap-3 border-b border-white/[0.06] py-2 text-sm last:border-b-0">
                <span className={m.open ? "text-danger-fg" : "text-ok-fg"}>●</span>
                <span className="flex-1">
                  {m.name} <span className="text-muted-foreground">{m.open ? `open since ${hhmmUtc(new Date(m.open.opened_at).toISOString())}` : "ok"}</span>
                </span>
                <span className={cn("font-mono", m.open ? "text-danger-fg" : "text-muted-foreground")}>
                  {m.open?.last_value != null ? formatValue(m.open.last_value, m.saved?.agg ?? "count") : m.open ? "open" : "ok"}
                </span>
              </div>
            ))}
            {props.readOnly ? <p className="m-0 text-sm text-muted-foreground">read-only for you · ask an Operator to change one</p> : null}
            {monitors.length === 0 && !props.readOnly ? <p className="m-0 text-sm text-muted-foreground">Watch this on a hunt makes the first one.</p> : null}
          </section>
        </div>
      </main>

      {props.onNewBoard ? (
        <BoardNameDialog open={newBoard} onOpenChange={setNewBoard} title="New board" action="Create board" defaultName="" onSubmit={props.onNewBoard} />
      ) : null}
      {onRenameSaved ? (
        <BoardNameDialog
          open={renaming !== null}
          onOpenChange={(open) => {
            if (!open) {
              setRenaming(null);
            }
          }}
          title={renaming?.board ? "Rename board" : "Rename saved hunt"}
          action="Rename"
          defaultName={renaming?.name ?? ""}
          onSubmit={async (name) => {
            if (renaming && name !== renaming.name) {
              await onRenameSaved(renaming, name);
            }
          }}
        />
      ) : null}
    </div>
  );
}

function MarkChip({ on, mark, label, time, onClick }: { on: boolean; mark?: ChangeMark; label: string; time: string; onClick?: () => void }) {
  const glyph = mark ? markGlyph[mark.kind] : null;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={onClick ? on : undefined}
      className={cn(
        "inline-flex h-7.5 max-w-80 items-center gap-1.5 whitespace-nowrap rounded-md border border-white/10 bg-surface-2 px-2.5 font-mono text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        on && "border-plate bg-plate/10 text-foreground",
      )}
    >
      {glyph ? <span style={{ color: glyph.color }}>{glyph.glyph}</span> : null}
      <span className="truncate">{label}</span>
      <span className="text-muted-foreground">{time}</span>
    </button>
  );
}

/**
 * A saved hunt that moved (49b): name, value, delta, was, and a small spark split at the mark.
 * With fewer than four buckets that read anything, two bars instead: before and after (50b).
 */
function MovedCard({ card, name, quiet, onClick, menu }: { card: HomeCard; name: string; quiet: boolean; onClick: () => void; menu?: React.ReactNode }) {
  const delta = deltaText(card.before, card.after, card.kind);
  const up = !quiet && delta.up;
  const bars = drawsBeforeAfter(card) ? beforeAfterWidths(card.before, card.after) : null;
  const rows = sparkRows(card.spark, card.split_at);
  return (
    <div className="group relative flex min-w-0">
      <button
        type="button"
        onClick={onClick}
        className="flex h-29 min-w-0 flex-1 flex-col gap-1.5 rounded-lg border border-white/10 bg-surface-2 px-3.5 py-3 text-left hover:border-white/25 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span className={cn("w-full truncate text-sm font-medium", menu ? "pr-6" : "")}>{name}</span>
        <span className="flex items-baseline gap-1.5">
          <span className="text-xl font-semibold tracking-[-0.01em]">{formatValue(card.after, card.kind)}</span>
          <span className={cn("text-xs", up ? "text-danger-fg" : "text-muted-foreground")}>{delta.text}</span>
          <span className="truncate text-xs text-muted-foreground">was {formatValue(card.before, card.kind)}</span>
        </span>
        {bars ? (
          <span className="flex min-h-0 w-full flex-1 flex-col justify-center gap-1.5 font-mono text-2xs leading-none text-muted-foreground" aria-hidden="true">
            <BeforeAfterBar label="before" width={bars.before} className="bg-muted-foreground/30" />
            <BeforeAfterBar label="after" width={bars.after} className={up ? "bg-danger/70" : "bg-muted-foreground/30"} />
          </span>
        ) : (
          <span className="flex min-h-0 w-full flex-1 flex-col justify-center gap-1.5 font-mono text-2xs leading-none text-muted-foreground" aria-hidden="true">
            <SparkRow label="before" heights={rows.before} className="bg-muted-foreground/30" />
            <SparkRow label="after" heights={rows.after} className={up ? "bg-danger/70" : "bg-muted-foreground/30"} />
          </span>
        )}
      </button>
      {menu ? <span className="absolute top-2 right-2">{menu}</span> : null}
    </div>
  );
}

/** A busy Moved card's buckets on one side of the mark (51b), labelled like the before and after bars. */
function SparkRow({ label, heights, className }: { label: string; heights: number[]; className: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="w-10 shrink-0">{label}</span>
      <span className="flex h-3 min-w-0 flex-1 items-end gap-px">
        {heights.map((h, i) => (
          <span key={i} className={cn("min-w-0 flex-1 rounded-sm", className)} style={{ height: `${h}%` }} />
        ))}
      </span>
    </span>
  );
}

/**
 * Under Quiet (51b): the saved hunts that read only hosts that sent nothing in 7 days, the hosts,
 * and `Archive N…`, which asks once with each host and when it last sent anything (51c).
 */
function GoneLine({ items, hosts, onArchive }: { items: SavedSearch[]; hosts: GoneHost[]; onArchive: (items: SavedSearch[]) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const n = items.length;
  return (
    <div className="flex min-h-10 items-center gap-3 pb-1 pl-6 text-sm">
      <span className="shrink-0">{goneText(n)}</span>
      <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{hosts.map((h) => h.host).join(" · ")}</span>
      <span className="flex-1" />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" size="md" className="shrink-0">
            Archive {n}…
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" side="top" className="flex w-96 flex-col gap-2.5 p-4">
          <span className="text-base font-semibold">Archive {n} saved {n === 1 ? "hunt" : "hunts"}?</span>
          <span className="text-sm leading-[1.5] text-muted-foreground">
            Each reads a host that has sent nothing since its day below. They leave Home and search; their monitors stay. Archived on Home brings any back.
          </span>
          <div className="flex flex-col font-mono text-xs">
            {hosts.map((h) => (
              <div key={h.host} className="flex h-6 items-center gap-2">
                <span className="w-24 truncate">{h.host}</span>
                <span className="flex-1 text-muted-foreground">
                  {h.hunts} saved {h.hunts === 1 ? "hunt" : "hunts"}
                </span>
                <span className="text-muted-foreground">{goneSince(h.last_seen)}</span>
              </div>
            ))}
          </div>
          <div className="mt-0.5 flex justify-end gap-2">
            <Button type="button" variant="outline" size="md" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="md"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onArchive(items);
                  setOpen(false);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Archive {n}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** One of a Moved card's before and after bars (50b): its label, and its length against the larger side. */
function BeforeAfterBar({ label, width, className }: { label: string; width: number; className: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="w-10 shrink-0">{label}</span>
      <span className="flex min-w-0 flex-1">
        <span className={cn("block h-2 min-w-0.5 rounded-sm", className)} style={{ width: `${width}%` }} />
      </span>
    </span>
  );
}

/** Quiet, Archived or Coverage folded to a line (50b): its name, a faint count, and maybe more on the right. */
function FoldLine({ open, label, sub, right, after, onToggle }: { open: boolean; label: string; sub: string; right?: string | null; after?: React.ReactNode; onToggle: () => void }) {
  return (
    <div className="flex min-h-10 items-center gap-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md text-left text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {open ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
        <span className="shrink-0 text-foreground">{label}</span>
        <span className="min-w-0 truncate text-muted-foreground" title={sub}>{sub}</span>
        <span className="flex-1" />
        {right ? <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{right}</span> : null}
      </button>
      {after}
    </div>
  );
}

/** A saved hunt's ⋯ menu (50c): Open, Rename, Archive, then Delete…, which asks again in place. */
function SavedMenu({ item, onOpen, onRename, onArchive, onDelete }: { item: SavedSearch; onOpen: () => void; onRename: () => void; onArchive: () => void; onDelete: () => void }) {
  const [armed, setArmed] = useState(false);
  return (
    <DropdownMenu onOpenChange={(open) => !open && setArmed(false)}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`Menu for ${item.name}`}
          className="size-6 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 data-[state=open]:bg-control data-[state=open]:opacity-100"
        >
          <Ellipsis aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuItem onSelect={onOpen}>Open</DropdownMenuItem>
        <DropdownMenuItem onSelect={onRename}>Rename</DropdownMenuItem>
        <DropdownMenuItem className="h-auto flex-col items-start gap-0 py-1.5" onSelect={onArchive}>
          <span>Archive</span>
          <span className="text-xs text-muted-foreground">Off Home and search; its monitor stays</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-danger-fg focus:text-danger-fg"
          onSelect={(e) => {
            if (!armed) {
              // The first pick arms it in place, as a board's Delete does; the second deletes.
              e.preventDefault();
              setArmed(true);
              return;
            }
            onDelete();
          }}
        >
          <span className="truncate">{armed ? `Sure? Delete ${item.name}` : "Delete…"}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A board (49b): its name, `pinned` when on Home, a sketch of its panels on the grid, its counts. */
function BoardTile({ item, onClick }: { item: SavedSearch; onClick: () => void }) {
  const boxes = boardPreview(item.board);
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-30 min-w-0 flex-col gap-2 rounded-lg border border-white/10 bg-surface-2 px-3.5 py-3 text-left hover:border-white/25 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <span className="flex w-full items-center gap-2">
        <span className="truncate text-sm font-medium">{item.name}</span>
        <span className="flex-1" />
        {item.pinned ? <span className="text-xs text-plate">pinned</span> : null}
      </span>
      <span className={cn("relative w-full flex-1", boxes.length === 0 && "rounded-sm border border-dashed border-white/10")} aria-hidden="true">
        {boxes.map((b) => (
          <span key={b.id} className="absolute p-px" style={{ left: `${b.left}%`, top: `${b.top}%`, width: `${b.width}%`, height: `${b.height}%` }}>
            <span className="block size-full rounded-sm border border-white/[0.08] bg-surface-1" />
          </span>
        ))}
      </span>
      <span className="text-xs text-muted-foreground">{boardCountText(item.board)}</span>
    </button>
  );
}

/** A compact row of Quiet or Archived: the name opens it, its value when read, and its ⋯ menu or Unarchive on the right. */
function QuietRow({
  item,
  value,
  onClick,
  onOpenAgents,
  menu,
  menuShown,
}: {
  item: SavedSearch;
  value: string;
  onClick: () => void;
  onOpenAgents?: () => void;
  menu?: React.ReactNode;
  /** Unarchive shows at all times; a ⋯ menu shows on hover or focus. */
  menuShown?: boolean;
}) {
  return (
    <div className="group flex min-w-0 items-center gap-1 rounded-md hover:bg-white/[0.04] has-data-[state=open]:bg-white/[0.04]">
      <button
        type="button"
        className="flex min-w-0 flex-1 justify-between rounded-md px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={onClick}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{item.name}</span>
          {item.saved_by?.agent ? <AgentBadge name={item.saved_by.name} onOpen={onOpenAgents} /> : null}
          {item.pinned ? <span className="text-xs text-plate">pinned</span> : null}
          {item.board ? <span className="text-xs text-muted-foreground">board</span> : null}
        </span>
        {value ? <span className="ml-2 shrink-0 font-mono text-sm text-muted-foreground">{value}</span> : null}
      </button>
      {menu ? <span className={cn("flex shrink-0 justify-end pr-1", menuShown ? "" : "w-7")}>{menu}</span> : null}
    </div>
  );
}

function Line({ hex, text, sub, n, muted, tag }: { hex: string; text: string; sub: string; n: number; muted?: boolean; tag?: string }) {
  return (
    <div className={cn("flex items-start gap-3 border-b border-white/[0.06] py-2 text-sm last:border-b-0", muted && "text-muted-foreground")}>
      <span className={cn("font-mono", !muted && "text-plate")}>e1:{hex}</span>
      {tag ? <span className="shrink-0 rounded-sm border border-white/12 px-1.5 text-xs leading-[18px]">{tag}</span> : null}
      <span className="min-w-0 flex-1 truncate">
        {text} <span className="text-muted-foreground">{sub}</span>
      </span>
      <span className="font-mono">{formatCompactCount(n)}</span>
    </div>
  );
}

function FirstRun({ instanceName, savedCount, markCount, onOpenAccess }: { instanceName: string | null; savedCount: number; markCount: number; onOpenAccess: () => void }) {
  const done = firstRunSteps({ named: Boolean(instanceName), ingested: false, savedCount, markCount });
  const origin = typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:8080";
  const send = `curl -X POST ${origin}/api/ingest \\\n  -H "Authorization: Bearer $TOPOSCOPE_INGEST_TOKEN" \\\n  -d '{"service":"smoke","level":"info","message":"hello from the shell"}'`;
  const mark = `curl -X POST ${origin}/v1/marks -H "Authorization: Bearer $TOPOSCOPE_INGEST_TOKEN" \\\n  -d '{"kind":"deploy","label":"deployed: api v1.0","attrs":{"version":"v1.0"}}'`;
  const step = (i: number, title: string, body: React.ReactNode) => (
    <div className={cn("grid grid-cols-[44px_1fr] gap-x-4 rounded-xl border border-white/10 bg-surface-2 px-6 py-6", done[i] && "border-white/[0.06] text-muted-foreground", i > 0 && !done[i - 1] && "opacity-60")}>
      <div className={cn("flex size-[30px] items-center justify-center rounded-full border border-zinc-600 text-sm", done[i] ? "border-transparent bg-overlay text-ok-fg" : !done[i] && (i === 0 || done[i - 1]) ? "border-plate text-plate" : "")}>
        {done[i] ? "✓" : i + 1}
      </div>
      <div className="min-w-0">
        <div className={cn("text-base font-medium", done[i] ? "text-zinc-400" : "text-foreground")}>{title}</div>
        {body}
      </div>
    </div>
  );
  return (
    <main className={cn("flex flex-col gap-3 px-4 pt-10", pageReading)}>
      <h1 className="m-0 mb-1 text-xl font-semibold tracking-[-0.01em]">This instance has no logs yet</h1>
      <p className="m-0 mb-3.5 text-base leading-[1.5] text-muted-foreground">Three steps. Each one becomes a card on this page as it is done, so the home never changes shape under you.</p>
      {step(
        0,
        "Give the instance a name",
        <div className="text-sm text-muted-foreground">
          {instanceName ? (
            <>
              Named <span className="font-mono text-zinc-300">{instanceName}</span> · the sign-in page says it now
            </>
          ) : (
            "Settings → This instance. The sign-in page and the header say it, so two instances are never confused."
          )}
        </div>,
      )}
      {step(
        1,
        "Send something",
        <>
          <div className="text-sm text-muted-foreground">An app with an OpenTelemetry exporter sends straight in. Or paste one line to see a first event arrive.</div>
          <pre className="mt-3 mb-0 overflow-hidden whitespace-pre-wrap rounded-lg border border-white/10 bg-surface-1 px-3.5 py-3 font-mono text-sm leading-[1.6] text-zinc-300">{send}</pre>
          <div className="mt-3 flex items-center gap-2">
            <Button type="button" variant="outline" onClick={() => void navigator.clipboard.writeText(send)}>
              Copy
            </Button>
            <Button type="button" variant="ghost" onClick={onOpenAccess}>
              Make an ingest token
            </Button>
            <span className="text-sm text-muted-foreground">Vector, Fluent Bit and Alloy configs are in the ingest guide.</span>
            <div className="flex-1" />
            <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
              <span className="size-[7px] rounded-full bg-zinc-600" />
              waiting for the first event
            </span>
          </div>
        </>,
      )}
      {step(
        2,
        "Save a first hunt and post a mark",
        <>
          <div className="text-sm text-muted-foreground">A saved hunt is a card here. A deploy mark from CI is what the cards compare against.</div>
          <pre className="mt-3 mb-0 overflow-hidden whitespace-pre-wrap rounded-lg border border-white/10 bg-surface-1 px-3.5 py-3 font-mono text-sm leading-[1.6] text-zinc-300">{mark}</pre>
        </>,
      )}
    </main>
  );
}
