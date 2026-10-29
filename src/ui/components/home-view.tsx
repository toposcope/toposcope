import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { HomeCard, HomeSince } from "../../control/home-since";
import { formatCompactCount } from "../count-format";
import { deltaText, firstRunSteps, formatValue, hhmmUtc, markAge, markGlyph, resolvePick, sideText, type HomePick } from "../home-since";
import type { MonitorView, SavedSearch } from "../types";
import { AgentBadge, OpenAgent } from "./agent-badge";

export type HomeWindow = { from: string; to: string };

type Props = {
  /** The person looking (#307): their own hunts read "yours". */
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
};

const pickKey = "toposcope.homePick";

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

export function HomeView(props: Props) {
  const [data, setData] = useState<HomeSince | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [pick, setPick] = useState<HomePick | null>(() => readPick());
  const [note, setNote] = useState<string | null>(null);
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
        const autoNow = json.since.kind === "mark" ? json.since.mark.id : null;
        if (json.since.kind === "mark" && !json.since.auto && resolvePick(p, p.autoThen, json.marks) === null) {
          writePick(null);
          setPick(null);
          return;
        }
        void autoNow;
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
    return <main className="p-6 text-[13px] text-muted-foreground">{failed}</main>;
  }
  if (!data) {
    return <main className="p-6 text-[13px] text-muted-foreground">Loading…</main>;
  }
  if (!data.ingested) {
    return <FirstRun instanceName={props.instanceName} savedCount={props.saved.length} markCount={data.marks.length} onOpenAccess={props.onOpenAccess} />;
  }

  const nowMs = Date.parse(data.now);
  const since = data.since;
  const selectedId = since.kind === "mark" ? since.mark.id : null;
  const strip = data.marks.slice(0, 5);
  const more = data.marks.length - strip.length;
  const window: HomeWindow = { from: data.before.from, to: data.after.to };
  const cardById = new Map(data.cards.map((c) => [c.saved_id, c]));
  const monitors = [...props.monitors].sort((a, b) => Number(Boolean(b.open)) - Number(Boolean(a.open)));
  const openCount = monitors.filter((m) => m.open).length;
  const fp = data.fingerprints;
  const e1Query = fp ? fp.first_seen.map((r) => `e1:${r.hex}`).join(" OR ") : "";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 px-6 pt-3.5">
        <span className="mr-1 text-[12px] text-muted-foreground">Since</span>
        {since.kind === "hour" ? (
          <MarkChip on glyph="" color="" label="the last hour" time={`${hhmmUtc(data.after.from)} → ${hhmmUtc(data.after.to)}`} />
        ) : null}
        {since.kind === "hour" && data.marks.length === 0 ? <span className="text-[12px] text-muted-foreground">no mark in the last 24 h</span> : null}
        {strip.map((m) => (
          <MarkChip
            key={m.id}
            on={m.id === selectedId}
            glyph={markGlyph[m.kind].glyph}
            color={markGlyph[m.kind].color}
            label={m.title}
            time={hhmmUtc(m.ts)}
            onClick={() => choose(m.id)}
          />
        ))}
        {more > 0 ? <span className="inline-flex h-[30px] items-center rounded-[7px] border border-white/10 px-[11px] text-[12.5px] text-muted-foreground">{more} more today</span> : null}
        <div className="flex-1" />
        {since.kind === "mark" ? (
          <button type="button" className="h-[30px] rounded-[7px] border border-white/10 px-[11px] text-[12.5px] text-muted-foreground hover:text-foreground" onClick={() => choose("hour")}>
            last hour instead
          </button>
        ) : null}
        {props.readOnly ? null : note === null ? (
          <button type="button" className="h-[30px] rounded-[7px] border border-white/10 px-[11px] text-[12.5px] text-muted-foreground hover:text-foreground" onClick={() => setNote("")}>
            + note
          </button>
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
              className="h-[30px] w-[260px] rounded-[7px] border border-white/10 bg-[#0d0d0f] px-2.5 text-[12.5px] outline-none"
            />
            <Button type="submit" size="sm" variant="outline">
              ○ Add
            </Button>
          </form>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pt-5 pb-6">
          <div className="flex flex-wrap items-baseline gap-3.5">
            <h1 className="m-0 text-[20px] font-semibold tracking-[-0.01em]">
              {since.kind === "mark" ? (
                <>
                  What changed since <span className="text-plate">{since.mark.title}</span>
                </>
              ) : (
                "The last hour, against the hour before"
              )}
            </h1>
            <span className="font-mono text-[12.5px] text-muted-foreground">
              {since.kind === "mark"
                ? `${hhmmUtc(since.mark.ts)} UTC · ${markAge(since.mark.ts, nowMs)} · ${sideText(data.side_ms)}`
                : `${hhmmUtc(data.before.from)} → ${hhmmUtc(data.before.to)} · ${hhmmUtc(data.after.from)} → ${hhmmUtc(data.after.to)} · UTC`}
            </span>
            {since.kind === "mark" && !since.auto ? <span className="text-[12px] text-muted-foreground">· your pick, until a newer deploy or flag</span> : null}
          </div>

          {data.cards.length === 0 ? (
            <section className="rounded-[10px] border border-white/10 bg-[#131316] p-4 text-[12.5px] text-muted-foreground">
              Save a hunt and it is a card here, with its before → after around the mark.
            </section>
          ) : (
            <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2 xl:grid-cols-3">
              {data.cards.map((card) => {
                const item = props.saved.find((s) => s.id === card.saved_id);
                return (
                  <OpenAgent.Provider key={card.saved_id} value={props.onOpenAgents}>
                    <Card card={card} meId={props.meId ?? null} quiet={since.kind === "hour"} onClick={() => item && props.onOpenSaved(item, window, selectedId)} />
                  </OpenAgent.Provider>
                );
              })}
            </div>
          )}

          <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-2">
            <section className="flex flex-col gap-2.5 rounded-[10px] border border-white/10 bg-[#131316] px-[18px] py-4">
              <div className="flex justify-between">
                <span className="text-[13.5px] font-medium">New fingerprints{fp ? ` · ${fp.first_seen.length}${fp.more ? "+" : ""}` : " · none"}</span>
                {fp && fp.first_seen.length > 0 ? (
                  <button type="button" className="text-[12px] text-muted-foreground hover:text-foreground" onClick={() => props.onOpenHunt(e1Query, data.after)}>
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
                <p className="m-0 text-[12px] leading-[1.5] text-muted-foreground">
                  {since.kind === "hour" ? "Nothing new in the last hour." : "No fingerprint first seen after this mark, and none stopped."}
                </p>
              )}
            </section>
            <section className="flex flex-col gap-2.5 rounded-[10px] border border-white/10 bg-[#131316] px-[18px] py-4">
              <div className="flex justify-between">
                <span className="text-[13.5px] font-medium">Monitors · {openCount > 0 ? `${openCount} open` : monitors.length ? "all ok" : "none"}</span>
                <button type="button" className="text-[12px] text-muted-foreground hover:text-foreground" onClick={props.onOpenWatch}>
                  {monitors.length ? `all ${monitors.length} →` : "Watch →"}
                </button>
              </div>
              {monitors.slice(0, 4).map((m) => (
                <div key={m.id} className="flex items-start gap-3 border-b border-white/[0.06] py-2 text-[12.5px] last:border-b-0">
                  <span className={m.open ? "text-red-300" : "text-emerald-300"}>●</span>
                  <span className="flex-1">
                    {m.name} <span className="text-muted-foreground">{m.open ? `open since ${hhmmUtc(new Date(m.open.opened_at).toISOString())}` : "ok"}</span>
                  </span>
                  <span className={cn("font-mono", m.open ? "text-red-300" : "text-muted-foreground")}>
                    {m.open?.last_value != null ? formatValue(m.open.last_value, m.saved?.agg ?? "count") : m.open ? "open" : "ok"}
                  </span>
                </div>
              ))}
              {props.readOnly ? <p className="m-0 text-[12px] text-muted-foreground">read-only for you · ask an Operator to change one</p> : null}
              {monitors.length === 0 && !props.readOnly ? <p className="m-0 text-[12px] text-muted-foreground">Watch this on a hunt makes the first one.</p> : null}
            </section>
          </div>
        </main>

        <aside className="hidden w-[300px] shrink-0 flex-col gap-3 border-l border-white/[0.06] px-6 pt-5 lg:flex">
          <span className="text-[13.5px] font-medium">Saved hunts · {props.saved.filter((s) => !s.board).length}</span>
          <div className="flex flex-col gap-0.5 text-[13px]">
            {props.saved
              .filter((s) => !s.board)
              .map((s) => {
                const card = cardById.get(s.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    className={cn("flex justify-between rounded-md px-2.5 py-[7px] text-left hover:bg-white/[0.04]", s.id === selectedId && "bg-white/[0.06]")}
                    onClick={() => props.onOpenSaved(s, window, selectedId)}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate">{s.name}</span>
                      {s.saved_by?.agent ? <AgentBadge name={s.saved_by.name} onOpen={props.onOpenAgents} /> : null}
                    </span>
                    <span className="ml-2 font-mono text-[12px] text-muted-foreground">
                      {card ? (card.kind === "count" ? formatCompactCount(card.after ?? 0) : card.kind) : ""}
                    </span>
                  </button>
                );
              })}
          </div>
          {props.saved.some((s) => s.pinned || s.board) ? (
            <>
              <span className="mt-3 text-[13.5px] font-medium">Pinned</span>
              <div className="flex flex-col gap-0.5 text-[13px]">
                {props.saved
                  .filter((s) => s.pinned || s.board)
                  .map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className="flex justify-between rounded-md px-2.5 py-[7px] text-left hover:bg-white/[0.04]"
                      onClick={() => (s.board ? props.onOpenBoard(s) : props.onOpenSaved(s, window, selectedId))}
                    >
                      <span className="truncate">{s.name}</span>
                      <span className="ml-2 font-mono text-[12px] text-muted-foreground">{s.board ? `${s.widgets?.widgets.length ?? 0} panels` : "pinned"}</span>
                    </button>
                  ))}
              </div>
            </>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function MarkChip({ on, glyph, color, label, time, onClick }: { on: boolean; glyph: string; color: string; label: string; time: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-[30px] max-w-[320px] items-center gap-[7px] whitespace-nowrap rounded-[7px] border border-white/10 bg-[#131316] px-[11px] text-[12.5px] text-zinc-300",
        on && "border-plate bg-[#1d1d21] text-foreground",
      )}
    >
      {glyph ? <span style={{ color }}>{glyph}</span> : null}
      <span className="truncate">{label}</span>
      <b className="font-mono text-[11.5px] font-normal text-muted-foreground">{time}</b>
    </button>
  );
}

/** "Maya K." → "MK", as the header does (#305). */
export function initialsOf(name: string): string {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return "?";
  }
  return words.length === 1 ? words[0]!.slice(0, 2).toUpperCase() : (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}

function Card({ card, quiet, onClick, meId }: { card: HomeCard; quiet: boolean; onClick: () => void; meId: string | null }) {
  const delta = deltaText(card.before, card.after, card.kind);
  const up = !quiet && delta.up;
  const peak = Math.max(1, ...card.spark);
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[150px] flex-col gap-2.5 rounded-[10px] border border-white/10 bg-[#131316] px-[18px] py-4 text-left hover:border-zinc-500"
    >
      <div className="flex items-baseline justify-between">
        <span className="text-[13.5px] font-medium">{card.name}</span>
        <span className="font-mono text-[12px] text-muted-foreground">{card.kind}</span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-[24px] font-semibold tracking-[-0.01em]">{card.refused ? "—" : formatValue(card.after, card.kind)}</span>
        <span className={cn("font-mono text-[12.5px]", up ? "text-red-300" : "text-muted-foreground")}>{card.refused ? "refused" : delta.text}</span>
        <span className="text-[12px] text-muted-foreground">{card.refused ? card.refused : `was ${formatValue(card.before, card.kind)}`}</span>
      </div>
      <div className="relative mt-auto flex h-9 items-end gap-px" aria-hidden="true">
        {card.spark.map((v, i) => (
          <div
            key={i}
            className="min-w-0 flex-1"
            style={{ height: `${Math.max(2, Math.round((v / peak) * 36))}px`, background: i >= card.split_at && up ? "#c2410c" : "#3f3f46" }}
          />
        ))}
        <div className="absolute -top-1 bottom-0 w-px" style={{ left: `${card.spark.length ? (card.split_at / card.spark.length) * 100 : 50}%`, background: quiet ? "#3f3f46" : "#e7e1d3" }} />
      </div>
      {card.saved_by?.agent ? (
        <span className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
          <AgentBadge name={card.saved_by.name} />
        </span>
      ) : card.saved_by ? (
        <span className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
          <span className="inline-flex size-[18px] items-center justify-center rounded-full bg-[#27272a] text-[9px] font-semibold text-zinc-300">{initialsOf(card.saved_by.name)}</span>
          {card.saved_by.id === meId ? (card.shared ? "yours" : "yours · only you see it") : `saved by ${card.saved_by.name}`}
        </span>
      ) : null}
    </button>
  );
}

function Line({ hex, text, sub, n, muted }: { hex: string; text: string; sub: string; n: number; muted?: boolean }) {
  return (
    <div className={cn("flex items-start gap-3 border-b border-white/[0.06] py-2 text-[12.5px] last:border-b-0", muted && "text-muted-foreground")}>
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
    <div className={cn("grid grid-cols-[44px_1fr] gap-x-[18px] rounded-[10px] border border-white/10 bg-[#131316] px-6 py-[22px]", done[i] && "border-white/[0.06] text-muted-foreground", i > 0 && !done[i - 1] && "opacity-60")}>
      <div className={cn("flex size-[30px] items-center justify-center rounded-full border border-zinc-600 text-[13px]", done[i] ? "border-transparent bg-[#1d1d21] text-emerald-300" : !done[i] && (i === 0 || done[i - 1]) ? "border-plate text-plate" : "")}>
        {done[i] ? "✓" : i + 1}
      </div>
      <div className="min-w-0">
        <div className={cn("text-[15px] font-medium", done[i] ? "text-zinc-400" : "text-foreground")}>{title}</div>
        {body}
      </div>
    </div>
  );
  return (
    <main className="mx-auto flex w-full max-w-[820px] flex-col gap-3.5 px-4 pt-10">
      <h1 className="m-0 mb-1 text-[22px] font-semibold tracking-[-0.01em]">This instance has no logs yet</h1>
      <p className="m-0 mb-3.5 text-[13.5px] leading-[1.5] text-muted-foreground">Three steps. Each one becomes a card on this page as it is done, so the home never changes shape under you.</p>
      {step(
        0,
        "Give the instance a name",
        <div className="text-[12.5px] text-muted-foreground">
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
          <div className="text-[12.5px] text-muted-foreground">An app with an OpenTelemetry exporter sends straight in. Or paste one line to see a first event arrive.</div>
          <pre className="mt-3 mb-0 overflow-hidden whitespace-pre-wrap rounded-[7px] border border-white/10 bg-[#0d0d0f] px-3.5 py-3 font-mono text-[12px] leading-[1.6] text-zinc-300">{send}</pre>
          <div className="mt-3 flex items-center gap-2.5">
            <Button type="button" size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(send)}>
              Copy
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onOpenAccess}>
              Make an ingest token
            </Button>
            <span className="text-[12.5px] text-muted-foreground">Vector, Fluent Bit and Alloy configs are in the ingest guide.</span>
            <div className="flex-1" />
            <span className="inline-flex items-center gap-2 text-[12.5px] text-muted-foreground">
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
          <div className="text-[12.5px] text-muted-foreground">A saved hunt is a card here. A deploy mark from CI is what the cards compare against.</div>
          <pre className="mt-3 mb-0 overflow-hidden whitespace-pre-wrap rounded-[7px] border border-white/10 bg-[#0d0d0f] px-3.5 py-3 font-mono text-[12px] leading-[1.6] text-zinc-300">{mark}</pre>
        </>,
      )}
    </main>
  );
}
