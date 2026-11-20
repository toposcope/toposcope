import { ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { ChangeMark } from "../../shared/change-mark";
import type { HomeCard, HomeSince } from "../../control/home-since";
import { formatCompactCount } from "../count-format";
import { boardCountText, boardPreview, homeBoards, splitHunts } from "../home-saved";
import { agoText, deltaText, firstRunSteps, formatValue, hhmmUtc, markGlyph, markStrip, markWhen, resolvePick, sideText, type HomePick } from "../home-since";
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
};

const pickKey = "toposcope.homePick";
const quietKey = "toposcope.homeQuietOpen";

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
  const hunts = props.saved.filter((s) => !s.board);
  const boards = homeBoards(props.saved);
  const split = splitHunts(hunts, data.cards);
  const cardById = new Map(data.cards.map((c) => [c.saved_id, c]));
  const openHunt = (s: SavedSearch) => props.onOpenSaved(s, window, selectedId);

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
                <MovedCard key={item.id} card={card} name={item.name} quiet={hour} onClick={() => openHunt(item)} />
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

        {split.quiet.length > 0 ? (
          <section className="mt-6 border-t border-white/[0.06] pt-1.5" aria-label="Quiet">
            <div className="flex min-h-10 items-center gap-2">
              <Button type="button" variant="ghost" className="-ml-2 px-2 text-foreground" aria-expanded={quietOpen} onClick={() => toggleQuiet(!quietOpen)}>
                {quietOpen ? <ChevronDown className="text-muted-foreground" /> : <ChevronRight className="text-muted-foreground" />}
                Quiet
              </Button>
              <span className="text-sm text-muted-foreground">
                {split.quiet.length} saved hunt{split.quiet.length === 1 ? "" : "s"}, same as before
              </span>
            </div>
            {quietOpen ? (
              <div className="grid grid-cols-1 gap-x-6 gap-y-0.5 pb-2 text-sm md:grid-cols-2 xl:grid-cols-3">
                {split.quiet.map((s) => (
                  <QuietRow key={s.id} item={s} card={cardById.get(s.id)} onOpenAgents={props.onOpenAgents} onClick={() => openHunt(s)} />
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        {props.onOpenFields ? (
          <div className="mt-6">
            <EvidenceGaps coverage={coverage} selectedMarkId={selectedId} onOpenFields={props.onOpenFields} />
          </div>
        ) : null}

        <div className="mt-6 grid grid-cols-1 gap-3 lg:grid-cols-2">
          <section className="flex flex-col gap-2 rounded-xl border border-white/10 bg-surface-2 px-4 py-4">
            <div className="flex justify-between">
              <span className="text-base font-medium">New fingerprints{fp ? ` · ${fp.first_seen.length}${fp.more ? "+" : ""}` : " · none"}</span>
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
                  <Line key={r.hex} hex={r.hex} text={`${r.message} · stopped`} sub={r.service} n={0} muted />
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

/** A saved hunt that moved (49b): name, value, delta, was, and a small spark split at the mark. */
function MovedCard({ card, name, quiet, onClick }: { card: HomeCard; name: string; quiet: boolean; onClick: () => void }) {
  const delta = deltaText(card.before, card.after, card.kind);
  const up = !quiet && delta.up;
  const peak = Math.max(1, ...card.spark);
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-29 min-w-0 flex-col gap-1.5 rounded-lg border border-white/10 bg-surface-2 px-3.5 py-3 text-left hover:border-white/25 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <span className="w-full truncate text-sm font-medium">{name}</span>
      <span className="flex items-baseline gap-1.5">
        <span className="text-xl font-semibold tracking-[-0.01em]">{formatValue(card.after, card.kind)}</span>
        <span className={cn("text-xs", up ? "text-danger-fg" : "text-muted-foreground")}>{delta.text}</span>
        <span className="truncate text-xs text-muted-foreground">was {formatValue(card.before, card.kind)}</span>
      </span>
      <span className="relative flex w-full flex-1 items-end gap-px" aria-hidden="true">
        {card.spark.map((v, i) => (
          <span
            key={i}
            className={cn("min-w-0 flex-1", i >= card.split_at && up ? "bg-danger/70" : "bg-muted-foreground/30")}
            style={{ height: `${Math.max(4, Math.round((v / peak) * 100))}%` }}
          />
        ))}
      </span>
    </button>
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

function QuietRow({ item, card, onClick, onOpenAgents }: { item: SavedSearch; card: HomeCard | undefined; onClick: () => void; onOpenAgents?: () => void }) {
  const value = !card ? "" : card.refused ? "refused" : card.kind === "count" ? formatCompactCount(card.after ?? 0) : formatValue(card.after, card.kind);
  return (
    <button
      type="button"
      className="flex min-w-0 justify-between rounded-md px-2 py-1.5 text-left hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      onClick={onClick}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate">{item.name}</span>
        {item.saved_by?.agent ? <AgentBadge name={item.saved_by.name} onOpen={onOpenAgents} /> : null}
        {item.pinned ? <span className="text-xs text-plate">pinned</span> : null}
      </span>
      <span className="ml-2 shrink-0 font-mono text-sm text-muted-foreground">{value}</span>
    </button>
  );
}

function Line({ hex, text, sub, n, muted }: { hex: string; text: string; sub: string; n: number; muted?: boolean }) {
  return (
    <div className={cn("flex items-start gap-3 border-b border-white/[0.06] py-2 text-sm last:border-b-0", muted && "text-muted-foreground")}>
      <span className={cn("font-mono", !muted && "text-plate")}>e1:{hex}</span>
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
